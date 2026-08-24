import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { Redis } from "ioredis";
import type { AppConfig } from "@app/config";
import { getPrismaClient } from "@app/db";
import { rootLogger } from "@app/shared";
import "./context.js";
import { createAuthPreHandler } from "./middleware/auth.js";
import { createErrorHandler } from "./middleware/error-handler.js";
import { checkRateLimit } from "./rate-limit.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerTenantManagementRoutes } from "./routes/tenant-management.js";
import { registerAppointmentRoutes } from "./routes/appointments.js";
import { registerAuditRoutes } from "./routes/audit.js";
import { registerApiKeyRoutes } from "./routes/api-keys.js";
import { registerWhatsappWebhookRoutes } from "./routes/whatsapp-webhook.js";

export function buildApp(config: AppConfig, deps?: { redis?: Redis }): FastifyInstance {
  const prisma = getPrismaClient();
  const redis = deps?.redis ?? new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });

  // Fastify's built-in pino logger already produces structured JSON logs
  // (docs/DEVELOPMENT.md §5) - not wiring in the shared rootLogger instance
  // here directly, since Fastify's typed logger slot doesn't accept an
  // arbitrary pino instance without losing route-handler type safety.
  // rootLogger is still used directly by the error handler below.
  const app = Fastify({ logger: true });

  // Captures the exact JSON bytes Meta sent alongside the parsed body -
  // the WhatsApp webhook's X-Hub-Signature-256 is an HMAC over those raw
  // bytes (docs/WHATSAPP.md §4), which a reserialized JSON.stringify()
  // can't be trusted to reproduce byte-for-byte.
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (request, body, done) => {
    request.rawBody = body as Buffer;
    if (body.length === 0) {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse((body as Buffer).toString("utf8")));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  const authConfig = {
    accessSecret: config.JWT_ACCESS_SECRET,
    accessTtlMinutes: config.JWT_ACCESS_TTL_MINUTES,
    refreshTtlDays: config.JWT_REFRESH_TTL_DAYS,
  };

  void app.register(cookie);

  app.addHook("preHandler", createAuthPreHandler(prisma, authConfig));

  // Baseline per-IP protection on every request - docs/SECURITY.md §8.
  // Endpoint-specific, tighter limits (login, hold) layer on top of this.
  app.addHook("onRequest", async (request) => {
    await checkRateLimit(redis, { scope: "IP", key: request.ip, limit: 300, windowSeconds: 60 });
  });

  app.setErrorHandler(createErrorHandler(rootLogger));

  app.get("/healthz", async () => ({ status: "ok" }));

  registerAuthRoutes(app, { prisma, authConfig, redis });
  registerTenantManagementRoutes(app, { prisma });
  registerAppointmentRoutes(app, {
    prisma,
    holdTtlMinutes: config.DEFAULT_HOLD_TTL_MINUTES,
    noShowGraceMinutes: config.DEFAULT_NO_SHOW_GRACE_MINUTES,
    queueRedis: redis,
  });
  registerAuditRoutes(app, { prisma });
  registerApiKeyRoutes(app, { prisma });
  registerWhatsappWebhookRoutes(app, {
    prisma,
    queueRedis: redis,
    appSecret: config.WHATSAPP_APP_SECRET,
    verifyToken: config.WHATSAPP_VERIFY_TOKEN,
  });

  app.addHook("onClose", async () => {
    redis.disconnect();
  });

  return app;
}
