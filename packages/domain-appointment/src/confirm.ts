import type { Appointment, Prisma, PrismaClient } from "@app/db";
import { withTenantContext } from "@app/db";
import { HoldExpiredError, InvalidTransitionError, domainEventBus } from "@app/shared";
import { withIdempotency } from "./idempotency.js";
import { lockAppointment } from "./lock.js";
import type { Actor, IdempotentRequest } from "./types.js";

export interface ConfirmAppointmentInput extends IdempotentRequest {
  appointmentId: string;
  actor: Actor;
  /** Set internally by rescheduleAppointment, which emits its own "appointment.rescheduled" event instead. */
  suppressEvent?: boolean;
}

export interface ConfirmAppointmentOutput {
  appointment: Appointment;
  replayed: boolean;
}

const CONFIRM_ENDPOINT = "appointments.confirm";

export async function confirmAppointment(
  prisma: PrismaClient,
  input: ConfirmAppointmentInput,
): Promise<ConfirmAppointmentOutput> {
  return withTenantContext(prisma, input.tenantId, (tx) => confirmAppointmentTx(tx, input));
}

export async function confirmAppointmentTx(
  tx: Prisma.TransactionClient,
  input: ConfirmAppointmentInput,
): Promise<ConfirmAppointmentOutput> {
  const { result, replayed } = await withIdempotency(
    tx,
    {
      tenantId: input.tenantId,
      key: input.idempotencyKey,
      endpoint: CONFIRM_ENDPOINT,
      requestHash: input.requestHash,
    },
    async () => {
      const current = await lockAppointment(tx, input.appointmentId);

      if (current.status !== "HELD") {
        throw new InvalidTransitionError(current.status, "CONFIRMED");
      }
      // Re-checked under the lock: the hold-expiry worker (docs/APPOINTMENT_ENGINE.md
      // §5) could have just flipped this to EXPIRED a moment before we
      // acquired the lock - the status check above already caught that
      // case (not HELD anymore), but a hold that is *still* HELD yet past
      // its TTL - expiry job hasn't run yet - must also be rejected here,
      // rather than confirming a hold that's logically already dead.
      if (!current.holdExpiresAt || current.holdExpiresAt <= new Date()) {
        throw new HoldExpiredError();
      }

      await tx.appointment.update({
        where: { id: current.id },
        data: { status: "CONFIRMED", confirmedAt: new Date() },
      });

      await tx.appointmentEvent.create({
        data: {
          tenantId: input.tenantId,
          appointmentId: current.id,
          fromStatus: "HELD",
          toStatus: "CONFIRMED",
          actorType: input.actor.type,
          actorId: input.actor.id ?? null,
        },
      });

      return {
        result: { appointmentId: current.id },
        responseBody: { appointmentId: current.id },
        responseStatus: 200,
      };
    },
  );

  const appointment = await tx.appointment.findUniqueOrThrow({
    where: { id: result.appointmentId },
  });

  if (!replayed && !input.suppressEvent) {
    domainEventBus.emit("appointment.confirmed", {
      tenantId: input.tenantId,
      appointmentId: appointment.id,
      doctorId: appointment.doctorId,
      patientId: appointment.patientId,
      occurredAt: new Date().toISOString(),
    });
  }

  return { appointment, replayed };
}
