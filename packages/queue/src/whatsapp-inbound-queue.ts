import { Queue } from "bullmq";
import type { Redis } from "ioredis";

export const WHATSAPP_INBOUND_QUEUE_NAME = "whatsapp-inbound";

/** Mirrors domain-whatsapp's InboundMessage shape - duplicated here rather than imported to keep this package dependency-free of domain packages (it's infrastructure, not business logic). */
export interface WhatsappInboundJobData {
  tenantId: string;
  message: {
    waMessageId: string;
    businessPhoneNumberId: string;
    fromPhone: string;
    timestamp: string;
    contactName?: string;
    kind: "text" | "list_reply" | "button_reply" | "unsupported";
    text?: string;
    replyId?: string;
  };
}

let queue: Queue<WhatsappInboundJobData> | undefined;

export function getWhatsappInboundQueue(connection: Redis): Queue<WhatsappInboundJobData> {
  queue ??= new Queue<WhatsappInboundJobData>(WHATSAPP_INBOUND_QUEUE_NAME, { connection });
  return queue;
}

/**
 * The webhook route enqueues fast and returns 200 immediately -
 * docs/WHATSAPP.md §4. jobId = wa_message_id gives a second layer of
 * dedup on top of the whatsapp_messages unique index the route already
 * checked, in case the same message is ever enqueued twice.
 */
export async function enqueueWhatsappInbound(connection: Redis, data: WhatsappInboundJobData): Promise<void> {
  const q = getWhatsappInboundQueue(connection);
  await q.add("process", data, { jobId: data.message.waMessageId, attempts: 3, backoff: { type: "exponential", delay: 2000 } });
}
