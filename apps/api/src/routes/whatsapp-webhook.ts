import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type { PrismaClient } from "@app/db";
import { parseInboundWebhook, recordInboundMessageIfNew, verifyWhatsAppSignature } from "@app/domain-whatsapp";
import { findTenantByWhatsappPhoneNumberId } from "@app/domain-tenant";
import { enqueueWhatsappInbound } from "@app/queue";
import { rootLogger } from "@app/shared";

/**
 * Public, unauthenticated routes for the WhatsApp Business Cloud API -
 * docs/WHATSAPP.md §4. Trust comes from the GET handshake's verify token
 * and the POST route's HMAC signature, not from the Authorization header
 * every other route relies on.
 */
export function registerWhatsappWebhookRoutes(
  app: FastifyInstance,
  deps: { prisma: PrismaClient; queueRedis: Redis; appSecret: string; verifyToken: string },
): void {
  app.get("/v1/webhooks/whatsapp", async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    if (query["hub.mode"] === "subscribe" && query["hub.verify_token"] === deps.verifyToken) {
      reply.status(200).type("text/plain").send(query["hub.challenge"] ?? "");
      return;
    }
    reply.status(403).send();
  });

  app.post("/v1/webhooks/whatsapp", async (request, reply) => {
    const signatureHeader = request.headers["x-hub-signature-256"];
    const valid = verifyWhatsAppSignature({
      rawBody: request.rawBody ?? Buffer.alloc(0),
      signatureHeader: typeof signatureHeader === "string" ? signatureHeader : undefined,
      appSecret: deps.appSecret,
    });
    if (!valid) {
      reply.status(401).send();
      return;
    }

    const parsed = parseInboundWebhook(request.body);

    for (const message of parsed.messages) {
      const tenant = await findTenantByWhatsappPhoneNumberId(deps.prisma, message.businessPhoneNumberId);
      if (!tenant) {
        rootLogger.warn(
          { phoneNumberId: message.businessPhoneNumberId },
          "whatsapp webhook: no tenant mapped to this phone_number_id",
        );
        continue;
      }
      const isNew = await recordInboundMessageIfNew(deps.prisma, tenant.id, message.waMessageId);
      if (!isNew) continue;
      await enqueueWhatsappInbound(deps.queueRedis, { tenantId: tenant.id, message });
    }

    // Delivery/read receipts aren't acted on in this phase - acknowledged
    // so Meta doesn't retry, not persisted (docs/WHATSAPP.md §4 scope).
    if (parsed.statuses.length > 0) {
      rootLogger.debug({ count: parsed.statuses.length }, "whatsapp webhook: status updates received");
    }

    reply.status(200).send({ status: "ok" });
  });
}
