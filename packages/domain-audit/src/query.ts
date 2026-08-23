import type { AuditLog, PrismaClient } from "@app/db";
import { withTenantContext } from "@app/db";

export interface ListAuditLogInput {
  tenantId: string;
  resourceType?: string;
  resourceId?: string;
  from?: Date;
  to?: Date;
  cursor?: string;
  limit: number;
}

export interface ListAuditLogOutput {
  entries: AuditLog[];
  nextCursor: string | null;
}

/** Backs `GET /v1/audit-log` - docs/API.md §4. */
export async function listAuditLog(
  prisma: PrismaClient,
  input: ListAuditLogInput,
): Promise<ListAuditLogOutput> {
  return withTenantContext(prisma, input.tenantId, async (tx) => {
    const entries = await tx.auditLog.findMany({
      where: {
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        createdAt: { gte: input.from, lte: input.to },
      },
      orderBy: { createdAt: "desc" },
      take: input.limit + 1,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    });

    const hasMore = entries.length > input.limit;
    const page = hasMore ? entries.slice(0, input.limit) : entries;
    const last = page.at(-1);

    return { entries: page, nextCursor: hasMore && last ? last.id : null };
  });
}
