import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PrismaClient } from "@app/db";
import { assertCan, createApiKey, listApiKeys, revokeApiKey } from "@app/domain-identity";
import { writeAuditLog } from "@app/domain-audit";
import { requireUserAuth } from "../middleware/auth.js";
import { parseBody } from "../validate.js";

const createApiKeySchema = z.object({
  name: z.string().min(1).max(200),
});

/**
 * Lets a tenant admin mint the API key a WordPress plugin (or any other
 * server-to-server integration) authenticates with - docs/API.md §5.
 * Deliberately TENANT_ADMIN-only (see domain-identity's policy.ts): an API
 * key is broad, standing access to the booking API, not a day-to-day
 * clinic-staff action.
 */
export function registerApiKeyRoutes(app: FastifyInstance, deps: { prisma: PrismaClient }): void {
  const { prisma } = deps;

  app.get("/v1/api-keys", async (request) => {
    const auth = requireUserAuth(request);
    if (!auth.tenantId) throw new Error("Platform users cannot manage API keys via this endpoint.");
    assertCan(auth.roles, "api_key:read");
    const keys = await listApiKeys(prisma, { tenantId: auth.tenantId });
    // hashedKey never leaves the server - only the prefix, for the admin to recognize which key is which.
    return { apiKeys: keys.map((k) => ({ id: k.id, name: k.name, keyPrefix: k.keyPrefix, status: k.status, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt })) };
  });

  app.post("/v1/api-keys", async (request, reply) => {
    const auth = requireUserAuth(request);
    if (!auth.tenantId) throw new Error("Platform users cannot manage API keys via this endpoint.");
    assertCan(auth.roles, "api_key:write");
    const body = parseBody(createApiKeySchema, request.body);

    const { raw, apiKey } = await createApiKey(prisma, { tenantId: auth.tenantId, name: body.name });

    await writeAuditLog(prisma, {
      tenantId: auth.tenantId,
      actorType: "USER",
      actorId: auth.userId,
      action: "api_key.create",
      resourceType: "api_key",
      resourceId: apiKey.id,
      after: { id: apiKey.id, name: apiKey.name, keyPrefix: apiKey.keyPrefix },
      requestId: request.id,
      ip: request.ip,
    });

    // The only point in this key's lifetime the raw secret is ever returned -
    // the admin must copy it into the WordPress plugin's settings now.
    reply.status(201).send({ id: apiKey.id, name: apiKey.name, keyPrefix: apiKey.keyPrefix, rawKey: raw });
  });

  app.delete<{ Params: { id: string } }>("/v1/api-keys/:id", async (request, reply) => {
    const auth = requireUserAuth(request);
    if (!auth.tenantId) throw new Error("Platform users cannot manage API keys via this endpoint.");
    assertCan(auth.roles, "api_key:write");
    await revokeApiKey(prisma, { tenantId: auth.tenantId, apiKeyId: request.params.id });
    await writeAuditLog(prisma, {
      tenantId: auth.tenantId,
      actorType: "USER",
      actorId: auth.userId,
      action: "api_key.revoke",
      resourceType: "api_key",
      resourceId: request.params.id,
      requestId: request.id,
      ip: request.ip,
    });
    reply.status(204).send();
  });
}
