import type { ActorType, Prisma, PrismaClient } from "@app/db";
import { withPlatformContext, withTenantContext } from "@app/db";

export interface AuditEntry {
  tenantId: string | null;
  actorType: ActorType;
  actorId?: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  before?: Prisma.InputJsonValue;
  after?: Prisma.InputJsonValue;
  ip?: string;
  userAgent?: string;
  requestId?: string;
}

/**
 * All audit writes are synchronous in this phase (docs/ARCHITECTURE.md §7's
 * async audit-write queue, with a sync fallback for security-critical
 * events, is a Phase-2+ optimization once the general event-to-queue
 * wiring exists) - correctness and completeness come first; the queue is
 * a durability/latency optimization on top, not a requirement to have
 * *any* audit trail at all. The audit_log table itself remains insert-only
 * regardless of write path (docs/SECURITY.md §9).
 */
export async function writeAuditLog(prisma: PrismaClient, entry: AuditEntry): Promise<void> {
  const data = {
    tenantId: entry.tenantId,
    actorType: entry.actorType,
    actorId: entry.actorId,
    action: entry.action,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId,
    before: entry.before,
    after: entry.after,
    ip: entry.ip,
    userAgent: entry.userAgent,
    requestId: entry.requestId,
  };

  if (entry.tenantId) {
    await withTenantContext(prisma, entry.tenantId, (tx) => tx.auditLog.create({ data }));
  } else {
    await withPlatformContext(prisma, (tx) => tx.auditLog.create({ data }));
  }
}
