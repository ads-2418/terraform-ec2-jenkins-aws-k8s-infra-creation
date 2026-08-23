import { Prisma } from "@app/db";

/** Postgres unique_violation (23505), surfaced by Prisma as P2002. */
export function isUniqueConstraintViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}
