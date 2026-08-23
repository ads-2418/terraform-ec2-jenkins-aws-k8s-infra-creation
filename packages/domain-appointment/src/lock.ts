import type { Appointment, Prisma } from "@app/db";
import { NotFoundError } from "@app/shared";

/**
 * Every transition below (confirm/cancel/reschedule/expire/complete/
 * no-show) starts by locking its appointment row, then re-reads status
 * under that lock - never trusting a status value read before the lock
 * was acquired. Mirrors the hold-side discipline in hold.ts.
 */
export async function lockAppointment(
  tx: Prisma.TransactionClient,
  appointmentId: string,
): Promise<Appointment> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM appointments WHERE id = ${appointmentId} FOR UPDATE
  `;
  if (rows.length === 0) throw new NotFoundError("Appointment");
  return tx.appointment.findUniqueOrThrow({ where: { id: appointmentId } });
}
