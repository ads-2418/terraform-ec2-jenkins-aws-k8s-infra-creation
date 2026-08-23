import { createHash } from "node:crypto";

/** Hashes the semantically relevant request fields for idempotency-key replay comparison - docs/APPOINTMENT_ENGINE.md §6. */
export function hashRequestBody(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}
