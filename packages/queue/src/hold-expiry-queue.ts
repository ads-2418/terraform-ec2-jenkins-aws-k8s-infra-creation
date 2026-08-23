import { Queue } from "bullmq";
import type { Redis } from "ioredis";

export const HOLD_EXPIRY_QUEUE_NAME = "hold-expiry";

export interface HoldExpiryJobData {
  tenantId: string;
  appointmentId: string;
}

let queue: Queue<HoldExpiryJobData> | undefined;

export function getHoldExpiryQueue(connection: Redis): Queue<HoldExpiryJobData> {
  queue ??= new Queue<HoldExpiryJobData>(HOLD_EXPIRY_QUEUE_NAME, { connection });
  return queue;
}

/**
 * Scheduled at hold creation with delay = the tenant's hold TTL -
 * docs/ARCHITECTURE.md §5 and docs/APPOINTMENT_ENGINE.md §5. jobId is the
 * appointment id, so a duplicate enqueue (e.g. a retried hold request that
 * somehow got past idempotency) collapses onto the same delayed job rather
 * than scheduling two expiries for one appointment.
 */
export async function enqueueHoldExpiry(
  connection: Redis,
  data: HoldExpiryJobData,
  delayMs: number,
): Promise<void> {
  const q = getHoldExpiryQueue(connection);
  await q.add("expire", data, { jobId: data.appointmentId, delay: delayMs });
}
