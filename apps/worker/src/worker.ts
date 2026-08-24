import { loadConfig } from "@app/config";
import { getPrismaClient } from "@app/db";
import { createQueueRedisConnection } from "@app/queue";
import { rootLogger } from "@app/shared";
import { createHoldExpiryWorker } from "./hold-expiry-worker.js";
import { createWhatsappInboundWorker } from "./whatsapp-inbound-worker.js";

const config = loadConfig();
const prisma = getPrismaClient();
const connection = createQueueRedisConnection(config.REDIS_URL);

const holdExpiryWorker = createHoldExpiryWorker(connection, prisma, rootLogger);
const whatsappInboundWorker = createWhatsappInboundWorker(
  connection,
  prisma,
  {
    accessToken: config.WHATSAPP_ACCESS_TOKEN,
    apiVersion: config.WHATSAPP_API_VERSION,
    holdTtlMinutes: config.DEFAULT_HOLD_TTL_MINUTES,
  },
  rootLogger,
);

holdExpiryWorker.on("failed", (job, err) => {
  rootLogger.error({ err, jobId: job?.id, data: job?.data }, "hold-expiry job failed");
});
whatsappInboundWorker.on("failed", (job, err) => {
  rootLogger.error({ err, jobId: job?.id, data: job?.data }, "whatsapp-inbound job failed");
});

rootLogger.info(
  { simulated: !config.WHATSAPP_ACCESS_TOKEN },
  "worker started: hold-expiry, whatsapp-inbound",
);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void Promise.all([holdExpiryWorker.close(), whatsappInboundWorker.close(), prisma.$disconnect()]).then(() =>
      process.exit(0),
    );
  });
}
