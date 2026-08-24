import { Prisma, withTenantContext, type PrismaClient } from "@app/db";

function isUniqueConstraintViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

/**
 * Records an inbound message's wa_message_id before it's queued, so a
 * webhook redelivery (Meta retries aggressively until it sees 200) is
 * recognized and skipped here rather than relying solely on BullMQ's
 * jobId dedup downstream - docs/WHATSAPP.md §4. Returns false if this
 * exact message was already seen.
 */
export async function recordInboundMessageIfNew(
  prisma: PrismaClient,
  tenantId: string,
  waMessageId: string,
): Promise<boolean> {
  try {
    await withTenantContext(prisma, tenantId, (tx) =>
      tx.whatsappMessage.create({
        data: { tenantId, direction: "IN", waMessageId, status: "RECEIVED" },
      }),
    );
    return true;
  } catch (err) {
    if (isUniqueConstraintViolation(err)) return false;
    throw err;
  }
}
