import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@app/db";
import { listAuditLog } from "@app/domain-audit";
import { assertCan } from "@app/domain-identity";
import { requireUserAuth } from "../middleware/auth.js";

export function registerAuditRoutes(app: FastifyInstance, deps: { prisma: PrismaClient }): void {
  app.get("/v1/audit-log", async (request) => {
    const auth = requireUserAuth(request);
    if (!auth.tenantId) throw new Error("Platform-level audit query not implemented in this phase.");
    assertCan(auth.roles, "audit:read");

    const query = request.query as {
      resourceType?: string;
      resourceId?: string;
      from?: string;
      to?: string;
      cursor?: string;
      limit?: string;
    };

    return listAuditLog(deps.prisma, {
      tenantId: auth.tenantId,
      resourceType: query.resourceType,
      resourceId: query.resourceId,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      cursor: query.cursor,
      limit: query.limit ? Number(query.limit) : 20,
    });
  });
}
