import { Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import type { PrismaClient } from "@app/db";
import { expireHold } from "@app/domain-appointment";
import { HOLD_EXPIRY_QUEUE_NAME, type HoldExpiryJobData } from "@app/queue";
import type { Logger } from "@app/shared";

/**
 * docs/ARCHITECTURE.md §5 "hold-expiry" row: no retry needed because
 * expireHold's own re-check (docs/APPOINTMENT_ENGINE.md §5) makes running
 * this twice - e.g. after a worker crash and BullMQ's stalled-job
 * recovery - a safe no-op rather than a problem to guard against here.
 */
export function createHoldExpiryWorker(
  connection: Redis,
  prisma: PrismaClient,
  logger: Logger,
): Worker<HoldExpiryJobData> {
  return new Worker<HoldExpiryJobData>(
    HOLD_EXPIRY_QUEUE_NAME,
    async (job: Job<HoldExpiryJobData>) => {
      const result = await expireHold(prisma, {
        tenantId: job.data.tenantId,
        appointmentId: job.data.appointmentId,
      });
      logger.info(
        { appointmentId: job.data.appointmentId, expired: result.expired },
        "hold-expiry job processed",
      );
    },
    { connection },
  );
}
