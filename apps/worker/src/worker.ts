import { loadConfig } from "@app/config";
import { getPrismaClient } from "@app/db";
import { createQueueRedisConnection } from "@app/queue";
import { rootLogger } from "@app/shared";
import { createHoldExpiryWorker } from "./hold-expiry-worker.js";

const config = loadConfig();
const prisma = getPrismaClient();
const connection = createQueueRedisConnection(config.REDIS_URL);

const holdExpiryWorker = createHoldExpiryWorker(connection, prisma, rootLogger);

holdExpiryWorker.on("failed", (job, err) => {
  rootLogger.error({ err, jobId: job?.id, data: job?.data }, "hold-expiry job failed");
});

rootLogger.info("worker started: hold-expiry");

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void Promise.all([holdExpiryWorker.close(), prisma.$disconnect()]).then(() => process.exit(0));
  });
}
