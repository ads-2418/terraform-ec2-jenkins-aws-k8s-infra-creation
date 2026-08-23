import type { Appointment, AppointmentChannel, Prisma, PrismaClient } from "@app/db";
import { withTenantContext } from "@app/db";
import { InvalidTransitionError, domainEventBus } from "@app/shared";
import { confirmAppointmentTx } from "./confirm.js";
import { holdSlotTx } from "./hold.js";
import { withIdempotency } from "./idempotency.js";
import { lockAppointment } from "./lock.js";
import type { Actor, IdempotentRequest } from "./types.js";

export interface RescheduleAppointmentInput extends IdempotentRequest {
  existingAppointmentId: string;
  newStartAt: Date;
  channel: AppointmentChannel;
  actor: Actor;
  holdTtlMinutes: number;
  /** Staff-initiated reschedules skip re-confirmation - docs/APPOINTMENT_ENGINE.md §8. */
  staffInitiated: boolean;
}

export interface RescheduleAppointmentOutput {
  oldAppointment: Appointment;
  newAppointment: Appointment;
  replayed: boolean;
}

const RESCHEDULE_ENDPOINT = "appointments.reschedule";

/**
 * Composes holdSlotTx (+ confirmAppointmentTx for staff-initiated
 * reschedules) with the old appointment's transition to RESCHEDULED, all
 * in one transaction - docs/APPOINTMENT_ENGINE.md §8. If the new hold
 * fails (slot taken), the whole transaction rolls back: the original
 * appointment is untouched, never left cancelled with no replacement.
 */
export async function rescheduleAppointment(
  prisma: PrismaClient,
  input: RescheduleAppointmentInput,
): Promise<RescheduleAppointmentOutput> {
  return withTenantContext(prisma, input.tenantId, (tx) => rescheduleAppointmentTx(tx, input));
}

export async function rescheduleAppointmentTx(
  tx: Prisma.TransactionClient,
  input: RescheduleAppointmentInput,
): Promise<RescheduleAppointmentOutput> {
  const { result, replayed } = await withIdempotency(
    tx,
    {
      tenantId: input.tenantId,
      key: input.idempotencyKey,
      endpoint: RESCHEDULE_ENDPOINT,
      requestHash: input.requestHash,
    },
    async () => {
      const existing = await lockAppointment(tx, input.existingAppointmentId);
      if (existing.status !== "CONFIRMED" && existing.status !== "HELD") {
        throw new InvalidTransitionError(existing.status, "RESCHEDULED");
      }

      const { appointment: heldAppointment } = await holdSlotTx(tx, {
        tenantId: input.tenantId,
        clinicId: existing.clinicId,
        doctorId: existing.doctorId,
        serviceId: existing.serviceId,
        patientId: existing.patientId,
        startAt: input.newStartAt,
        channel: input.channel,
        actor: input.actor,
        holdTtlMinutes: input.holdTtlMinutes,
        // Same raw key as the outer reschedule call is fine: the
        // idempotency_keys unique constraint is (tenant, key, endpoint),
        // and holdSlotTx always writes under endpoint="appointments.hold"
        // - distinct from this function's "appointments.reschedule" - so
        // the two records can't collide.
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        rescheduledFromId: existing.id,
        suppressEvent: true,
      });

      let newAppointment = heldAppointment;
      if (input.staffInitiated) {
        const confirmResult = await confirmAppointmentTx(tx, {
          tenantId: input.tenantId,
          appointmentId: newAppointment.id,
          idempotencyKey: input.idempotencyKey,
          requestHash: input.requestHash,
          actor: { type: "SYSTEM" },
          suppressEvent: true,
        });
        newAppointment = confirmResult.appointment;
      }

      await tx.appointment.update({
        where: { id: existing.id },
        data: { status: "RESCHEDULED" },
      });

      await tx.appointmentEvent.create({
        data: {
          tenantId: input.tenantId,
          appointmentId: existing.id,
          fromStatus: existing.status,
          toStatus: "RESCHEDULED",
          actorType: input.actor.type,
          actorId: input.actor.id ?? null,
        },
      });

      return {
        result: { oldAppointmentId: existing.id, newAppointmentId: newAppointment.id },
        responseBody: { oldAppointmentId: existing.id, newAppointmentId: newAppointment.id },
        responseStatus: 200,
      };
    },
  );

  const [oldAppointment, newAppointment] = await Promise.all([
    tx.appointment.findUniqueOrThrow({ where: { id: result.oldAppointmentId } }),
    tx.appointment.findUniqueOrThrow({ where: { id: result.newAppointmentId } }),
  ]);

  if (!replayed) {
    domainEventBus.emit("appointment.rescheduled", {
      tenantId: input.tenantId,
      appointmentId: newAppointment.id,
      doctorId: newAppointment.doctorId,
      patientId: newAppointment.patientId,
      rescheduledFromId: oldAppointment.id,
      occurredAt: new Date().toISOString(),
    });
  }

  return { oldAppointment, newAppointment, replayed };
}
