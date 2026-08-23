import type { Appointment, CancelledBy, Prisma, PrismaClient } from "@app/db";
import { withTenantContext } from "@app/db";
import { InvalidTransitionError, domainEventBus } from "@app/shared";
import { withIdempotency } from "./idempotency.js";
import { lockAppointment } from "./lock.js";
import type { Actor, IdempotentRequest } from "./types.js";

export interface CancelAppointmentInput extends IdempotentRequest {
  appointmentId: string;
  reason?: string;
  cancelledBy: CancelledBy;
  actor: Actor;
}

export interface CancelAppointmentOutput {
  appointment: Appointment;
  replayed: boolean;
}

const CANCEL_ENDPOINT = "appointments.cancel";

/** Allowed from HELD (patient/staff abandons a pending hold) or CONFIRMED. */
export async function cancelAppointment(
  prisma: PrismaClient,
  input: CancelAppointmentInput,
): Promise<CancelAppointmentOutput> {
  return withTenantContext(prisma, input.tenantId, (tx) => cancelAppointmentTx(tx, input));
}

export async function cancelAppointmentTx(
  tx: Prisma.TransactionClient,
  input: CancelAppointmentInput,
): Promise<CancelAppointmentOutput> {
  const { result, replayed } = await withIdempotency(
    tx,
    {
      tenantId: input.tenantId,
      key: input.idempotencyKey,
      endpoint: CANCEL_ENDPOINT,
      requestHash: input.requestHash,
    },
    async () => {
      const current = await lockAppointment(tx, input.appointmentId);

      if (current.status !== "HELD" && current.status !== "CONFIRMED") {
        throw new InvalidTransitionError(current.status, "CANCELLED");
      }

      await tx.appointment.update({
        where: { id: current.id },
        data: {
          status: "CANCELLED",
          cancelledAt: new Date(),
          cancelledReason: input.reason,
          cancelledBy: input.cancelledBy,
        },
      });

      await tx.appointmentEvent.create({
        data: {
          tenantId: input.tenantId,
          appointmentId: current.id,
          fromStatus: current.status,
          toStatus: "CANCELLED",
          actorType: input.actor.type,
          actorId: input.actor.id ?? null,
          reason: input.reason,
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

  if (!replayed) {
    domainEventBus.emit("appointment.cancelled", {
      tenantId: input.tenantId,
      appointmentId: appointment.id,
      doctorId: appointment.doctorId,
      patientId: appointment.patientId,
      reason: input.reason,
      cancelledBy: input.cancelledBy,
      occurredAt: new Date().toISOString(),
    });
  }

  return { appointment, replayed };
}
