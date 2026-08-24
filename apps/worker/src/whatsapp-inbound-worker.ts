import { Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import type { PrismaClient } from "@app/db";
import {
  HttpWhatsAppSendClient,
  SimulatedWhatsAppSendClient,
  processInboundMessage,
  type WhatsAppSendClient,
} from "@app/domain-whatsapp";
import { WHATSAPP_INBOUND_QUEUE_NAME, type WhatsappInboundJobData } from "@app/queue";
import type { Logger } from "@app/shared";

export interface WhatsappWorkerConfig {
  accessToken: string | undefined;
  apiVersion: string;
  holdTtlMinutes: number;
}

/**
 * One send client per business phone number, reused across jobs - a
 * fresh HttpWhatsAppSendClient per message would be wasteful and a
 * single shared instance can't be built once at startup because the
 * phone number id (and therefore the send-from identity) only becomes
 * known per-message, not per-worker. docs/WHATSAPP.md §4.
 */
function buildSendClient(config: WhatsappWorkerConfig, phoneNumberId: string, logger: Logger): WhatsAppSendClient {
  if (!config.accessToken) {
    return new SimulatedWhatsAppSendClient(logger);
  }
  return new HttpWhatsAppSendClient(
    { accessToken: config.accessToken, phoneNumberId, apiVersion: config.apiVersion },
    logger,
  );
}

export function createWhatsappInboundWorker(
  connection: Redis,
  prisma: PrismaClient,
  config: WhatsappWorkerConfig,
  logger: Logger,
): Worker<WhatsappInboundJobData> {
  return new Worker<WhatsappInboundJobData>(
    WHATSAPP_INBOUND_QUEUE_NAME,
    async (job: Job<WhatsappInboundJobData>) => {
      const sendClient = buildSendClient(config, job.data.message.businessPhoneNumberId, logger);
      await processInboundMessage(prisma, sendClient, {
        tenantId: job.data.tenantId,
        message: job.data.message,
        holdTtlMinutes: config.holdTtlMinutes,
      });
      logger.info(
        { tenantId: job.data.tenantId, waMessageId: job.data.message.waMessageId },
        "whatsapp-inbound job processed",
      );
    },
    { connection },
  );
}
