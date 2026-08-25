import type { Prisma, PrismaClient } from "../generated/client/index.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class InvalidTenantIdError extends Error {
  constructor(tenantId: string) {
    super(`Invalid tenantId: ${tenantId}`);
    this.name = "InvalidTenantIdError";
  }
}

/**
 * Runs `fn` inside a transaction with `app.tenant_id` set for the duration
 * of that transaction, which is what every tenant-scoped Postgres RLS
 * policy checks (docs/DATABASE.md §1, migration 20260823210700).
 *
 * This is the ONLY sanctioned way tenant-scoped tables get queried.
 * Repositories in domain packages must call this rather than using the
 * raw PrismaClient directly - see the lint rule referenced in
 * docs/DATABASE.md §1 (not yet wired up as an actual lint rule in this
 * phase; enforced by code review discipline for now).
 *
 * `SET LOCAL` does not support query parameters (it's a utility statement,
 * not a regular SQL statement) - the tenantId is validated as a UUID and
 * then interpolated directly. tenantId must always come from a
 * server-derived source (JWT claim, resolved API key row), never from
 * unvalidated client input, per docs/SECURITY.md §3.
 *
 * `timeoutMs` overrides Prisma's default 5000ms interactive-transaction
 * timeout. Request-serving callers should never need this (a real request
 * is same-region, low-latency, and a 5s budget is itself a safety net
 * against a hung query) - it exists for long-running admin operations like
 * `prisma/seed.ts`, whose sequential inserts can outrun that budget when
 * run against a database reached over the public internet from a
 * different region (e.g. seeding a Render database from a Codespace).
 */
export async function withTenantContext<T>(
  prisma: PrismaClient,
  tenantId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options?: { timeoutMs?: number },
): Promise<T> {
  if (!UUID_RE.test(tenantId)) {
    throw new InvalidTenantIdError(tenantId);
  }
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${tenantId}'`);
      return fn(tx);
    },
    options?.timeoutMs ? { timeout: options.timeoutMs } : undefined,
  );
}

/**
 * Runs `fn` inside a transaction with NO tenant context set - matches the
 * `platform_level_access` RLS policies (rows where tenant_id IS NULL) and
 * the `bootstrap_lookup` policy on api_keys/refresh_tokens (exact-hash
 * lookups before the tenant is known). Never use this for anything other
 * than platform-admin operations or credential-bootstrap lookups - see
 * the migration's comments for exactly which tables behave which way
 * under a platform context.
 */
export async function withPlatformContext<T>(
  prisma: PrismaClient,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => fn(tx));
}
