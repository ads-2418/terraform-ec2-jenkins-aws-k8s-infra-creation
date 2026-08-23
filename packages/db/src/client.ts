import { PrismaClient } from "../generated/client/index.js";

let client: PrismaClient | undefined;

/**
 * Process-wide Prisma client singleton. Never instantiate PrismaClient
 * directly elsewhere - every connection must go through this so the pool
 * is shared and tenant-context transactions (see tenant-context.ts) are
 * the only way tenant-scoped tables get queried.
 */
export function getPrismaClient(): PrismaClient {
  if (!client) {
    client = new PrismaClient({
      log: process.env["NODE_ENV"] === "development" ? ["warn", "error"] : ["error"],
    });
  }
  return client;
}

export async function disconnectPrisma(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = undefined;
  }
}
