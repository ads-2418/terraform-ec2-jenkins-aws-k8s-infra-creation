import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@app/db";
import { withPlatformContext } from "@app/db";
import { assertCan } from "@app/domain-identity";
import { requireUserAuth } from "../middleware/auth.js";

/**
 * Cross-tenant visibility for the platform operator (the seller of this
 * SaaS) - not reachable by any tenant-scoped role. Answers "how many
 * integrations does each customer actually have" (a solo clinic vs. a
 * hospital chain running dozens of channel integrations), which is the
 * kind of usage signal a per-tenant licensing/billing model needs.
 *
 * PLATFORM_ADMIN is granted only to users with tenantId === null
 * (`packages/domain-identity/src/auth.ts`), so `requireUserAuth` +
 * `assertCan(..., "tenant:manage")` here is sufficient - a tenant-scoped
 * TENANT_ADMIN can never reach this route no matter what they send,
 * since their token's tenantId is never null and their roles never
 * include PLATFORM_ADMIN.
 */
export function registerPlatformRoutes(app: FastifyInstance, deps: { prisma: PrismaClient }): void {
  const { prisma } = deps;

  app.get("/v1/platform/tenants", async (request) => {
    const auth = requireUserAuth(request);
    assertCan(auth.roles, "tenant:manage");

    const [tenants, apiKeyCounts] = await withPlatformContext(prisma, async (tx) => {
      return Promise.all([
        tx.tenant.findMany({ orderBy: { createdAt: "asc" } }),
        // Under a platform context (no app.tenant_id set), api_keys' RLS
        // `bootstrap_lookup` policy makes every tenant's rows visible here -
        // the same policy that lets a raw API key resolve to its tenant
        // before any context exists (docs/DATABASE.md's RLS migration).
        tx.apiKey.groupBy({ by: ["tenantId", "status"], _count: { _all: true } }),
      ]);
    });

    const countsByTenant = new Map<string, { active: number; total: number }>();
    for (const row of apiKeyCounts) {
      const entry = countsByTenant.get(row.tenantId) ?? { active: 0, total: 0 };
      entry.total += row._count._all;
      if (row.status === "ACTIVE") entry.active += row._count._all;
      countsByTenant.set(row.tenantId, entry);
    }

    return {
      tenants: tenants.map((t) => ({
        id: t.id,
        name: t.name,
        slug: t.slug,
        status: t.status,
        createdAt: t.createdAt,
        activeApiKeyCount: countsByTenant.get(t.id)?.active ?? 0,
        totalApiKeyCount: countsByTenant.get(t.id)?.total ?? 0,
      })),
    };
  });
}
