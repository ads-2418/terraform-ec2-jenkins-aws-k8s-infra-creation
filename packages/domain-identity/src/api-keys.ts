import type { ApiKey, PrismaClient } from "@app/db";
import { withPlatformContext, withTenantContext } from "@app/db";
import { generateSecret, hashSecret } from "@app/shared";

/** Used by the WordPress plugin (and future service-to-service channels) - docs/SECURITY.md §1. */
export async function createApiKey(
  prisma: PrismaClient,
  input: { tenantId: string; name: string },
): Promise<{ raw: string; apiKey: ApiKey }> {
  const { raw, keyPrefix, hashedKey } = generateSecret("sk_live");
  const apiKey = await withTenantContext(prisma, input.tenantId, (tx) =>
    tx.apiKey.create({ data: { tenantId: input.tenantId, name: input.name, keyPrefix, hashedKey } }),
  );
  return { raw, apiKey };
}

/**
 * The bootstrap lookup: resolves which tenant a raw API key belongs to,
 * before any tenant context exists - see the `bootstrap_lookup` RLS
 * policy on api_keys (docs/DATABASE.md's RLS migration) and
 * docs/SECURITY.md §1.
 */
export async function resolveApiKey(prisma: PrismaClient, rawKey: string): Promise<ApiKey | null> {
  const hashedKey = hashSecret(rawKey);
  const record = await withPlatformContext(prisma, (tx) => tx.apiKey.findUnique({ where: { hashedKey } }));
  if (!record || record.status !== "ACTIVE") return null;

  await withTenantContext(prisma, record.tenantId, (tx) =>
    tx.apiKey.update({ where: { id: record.id }, data: { lastUsedAt: new Date() } }),
  );

  return record;
}

export async function revokeApiKey(prisma: PrismaClient, input: { tenantId: string; apiKeyId: string }): Promise<void> {
  await withTenantContext(prisma, input.tenantId, (tx) =>
    tx.apiKey.update({ where: { id: input.apiKeyId }, data: { status: "REVOKED" } }),
  );
}
