import { randomBytes, createHash } from "node:crypto";

/**
 * For high-entropy, machine-generated secrets (API keys, refresh tokens) -
 * NOT for user passwords, which use argon2id in password.ts instead. These
 * are looked up by exact-match hash (`WHERE hashed_key = $1`), which
 * requires a deterministic hash; argon2's per-call salt makes it unusable
 * for that lookup pattern. SHA-256 is appropriate here specifically
 * because the input already has 256 bits of entropy - there is nothing
 * for a slow/memory-hard hash to protect against that the entropy itself
 * doesn't already rule out.
 */
export function generateSecret(prefix: string): { raw: string; keyPrefix: string; hashedKey: string } {
  const random = randomBytes(32).toString("base64url");
  const raw = `${prefix}_${random}`;
  return {
    raw,
    keyPrefix: raw.slice(0, 12),
    hashedKey: hashSecret(raw),
  };
}

export function hashSecret(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}
