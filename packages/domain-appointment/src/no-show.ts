import type { Appointment, PrismaClient } from "@app/db";
import { withTenantContext } from "@app/db";
import { InvalidTransitionError, domainEventBus } from "@app/shared";
import { lockAppointment } from "./lock.js";
import type { Actor } from "./types.js";

export interface MarkNoShowInput {
  tenantId: string;
  appointmentId: string;
  actor: Actor;
  graceMinutes: number;
}

/**
 * Staff-driven or the auto-no-show cron scanning past-due CONFIRMED
 * appointments (docs/APPOINTMENT_ENGINE.md §9).
 */
export async function markNoShow(prisma: PrismaClient, input: MarkNoShowInput): Promise<Appointment> {
  return withTenantContext(prisma, input.tenantId, async (tx) => {
    const current = await lockAppointment(tx, input.appointmentId);
    if (current.status !== "CONFIRMED") {
      throw new InvalidTransitionError(current.status, "NO_SHOW");
    }
    const graceDeadline = new Date(current.endAt.getTime() + input.graceMinutes * 60_000);
    if (new Date() < graceDeadline) {
      throw new InvalidTransitionError(current.status, "NO_SHOW");
    }

    const updated = await tx.appointment.update({
      where: { id: current.id },
      data: { status: "NO_SHOW" },
    });

    await tx.appointmentEvent.create({
      data: {
        tenantId: input.tenantId,
        appointmentId: current.id,
        fromStatus: "CONFIRMED",
        toStatus: "NO_SHOW",
        actorType: input.actor.type,
        actorId: input.actor.id ?? null,
      },
    });

    domainEventBus.emit("appointment.no_show", {
      tenantId: input.tenantId,
      appointmentId: updated.id,
      doctorId: updated.doctorId,
      patientId: updated.patientId,
      occurredAt: new Date().toISOString(),
    });

    return updated;
  });
}
