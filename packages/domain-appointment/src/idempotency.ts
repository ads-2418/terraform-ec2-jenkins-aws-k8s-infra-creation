import type { Prisma } from "@app/db";
import { IdempotencyKeyReusedError } from "@app/shared";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Wraps a mutating operation with idempotency-key replay semantics -
 * docs/APPOINTMENT_ENGINE.md §6. Must be called from inside an existing
 * tenant-context transaction (`tx`), so the idempotency-key check, the
 * business mutation, and the key's own write all commit or roll back
 * together - a crash between them can never leave an orphaned "success
 * recorded but nothing happened" (or the reverse).
 */
export async function withIdempotency<T>(
  tx: Prisma.TransactionClient,
  args: { tenantId: string; key: string; endpoint: string; requestHash: string },
  fn: () => Promise<{ result: T; responseBody: Prisma.InputJsonValue; responseStatus: number }>,
): Promise<{ result: T; replayed: boolean }> {
  const existing = await tx.idempotencyKey.findUnique({
    where: { tenantId_key_endpoint: { tenantId: args.tenantId, key: args.key, endpoint: args.endpoint } },
  });

  if (existing) {
    if (existing.requestHash !== args.requestHash) {
      throw new IdempotencyKeyReusedError();
    }
    return { result: existing.responseBody as T, replayed: true };
  }

  const { result, responseBody, responseStatus } = await fn();

  await tx.idempotencyKey.create({
    data: {
      tenantId: args.tenantId,
      key: args.key,
      endpoint: args.endpoint,
      requestHash: args.requestHash,
      responseStatus,
      responseBody,
      expiresAt: new Date(Date.now() + DEFAULT_TTL_MS),
    },
  });

  return { result, replayed: false };
}
