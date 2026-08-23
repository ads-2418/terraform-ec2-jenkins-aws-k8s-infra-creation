import type { Appointment, Prisma, PrismaClient } from "@app/db";
import { withTenantContext } from "@app/db";
import { domainEventBus } from "@app/shared";
import { lockAppointment } from "./lock.js";

export interface ExpireHoldInput {
  tenantId: string;
  appointmentId: string;
}

export interface ExpireHoldOutput {
  appointment: Appointment;
  expired: boolean;
}

/**
 * Fired by the delayed `hold-expiry` BullMQ job scheduled at hold creation
 * (docs/ARCHITECTURE.md §5). Deliberately NOT a blind status flip: the
 * patient may have confirmed in the last few hundred milliseconds before
 * this job ran, so it re-checks status and TTL under the row lock and is a
 * clean no-op if the hold isn't (still) expired - see
 * docs/APPOINTMENT_ENGINE.md §5. No idempotency-key: this isn't a
 * client-facing endpoint, and the re-check itself is what makes running it
 * twice (e.g. a retried job after a worker crash) safe.
 */
export async function expireHold(
  prisma: PrismaClient,
  input: ExpireHoldInput,
): Promise<ExpireHoldOutput> {
  return withTenantContext(prisma, input.tenantId, (tx) => expireHoldTx(tx, input));
}

export async function expireHoldTx(
  tx: Prisma.TransactionClient,
  input: ExpireHoldInput,
): Promise<ExpireHoldOutput> {
  const current = await lockAppointment(tx, input.appointmentId);

  const isStillExpiredHold =
    current.status === "HELD" && current.holdExpiresAt !== null && current.holdExpiresAt <= new Date();

  if (!isStillExpiredHold) {
    return { appointment: current, expired: false };
  }

  const updated = await tx.appointment.update({
    where: { id: current.id },
    data: { status: "EXPIRED" },
  });

  await tx.appointmentEvent.create({
    data: {
      tenantId: input.tenantId,
      appointmentId: current.id,
      fromStatus: "HELD",
      toStatus: "EXPIRED",
      actorType: "SYSTEM",
    },
  });

  domainEventBus.emit("appointment.expired", {
    tenantId: input.tenantId,
    appointmentId: updated.id,
    doctorId: updated.doctorId,
    patientId: updated.patientId,
    occurredAt: new Date().toISOString(),
  });

  return { appointment: updated, expired: true };
}
