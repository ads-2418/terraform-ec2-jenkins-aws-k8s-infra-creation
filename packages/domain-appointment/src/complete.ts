import type { Appointment, PrismaClient } from "@app/db";
import { withTenantContext } from "@app/db";
import { InvalidTransitionError, domainEventBus } from "@app/shared";
import { lockAppointment } from "./lock.js";
import type { Actor } from "./types.js";

export interface CompleteAppointmentInput {
  tenantId: string;
  appointmentId: string;
  actor: Actor;
}

/**
 * Staff-driven (dashboard action) or the auto-complete job past
 * end_at + grace period (docs/APPOINTMENT_ENGINE.md §9). No
 * idempotency-key requirement (docs/API.md §3 marks this
 * "optional-but-honored" rather than required) - the status guard below
 * already makes a duplicate call a clean, safe no-op error rather than a
 * silent double side-effect.
 */
export async function completeAppointment(
  prisma: PrismaClient,
  input: CompleteAppointmentInput,
): Promise<Appointment> {
  return withTenantContext(prisma, input.tenantId, async (tx) => {
    const current = await lockAppointment(tx, input.appointmentId);
    if (current.status !== "CONFIRMED") {
      throw new InvalidTransitionError(current.status, "COMPLETED");
    }
    if (current.endAt > new Date()) {
      throw new InvalidTransitionError(current.status, "COMPLETED");
    }

    const updated = await tx.appointment.update({
      where: { id: current.id },
      data: { status: "COMPLETED" },
    });

    await tx.appointmentEvent.create({
      data: {
        tenantId: input.tenantId,
        appointmentId: current.id,
        fromStatus: "CONFIRMED",
        toStatus: "COMPLETED",
        actorType: input.actor.type,
        actorId: input.actor.id ?? null,
      },
    });

    domainEventBus.emit("appointment.completed", {
      tenantId: input.tenantId,
      appointmentId: updated.id,
      doctorId: updated.doctorId,
      patientId: updated.patientId,
      occurredAt: new Date().toISOString(),
    });

    return updated;
  });
}
