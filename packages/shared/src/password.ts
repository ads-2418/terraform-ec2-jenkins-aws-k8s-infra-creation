import * as argon2 from "argon2";

/**
 * argon2id, per docs/SECURITY.md §4. Never swap this for a reversible or
 * fast hash (bcrypt/md5/sha*) - argon2id is memory-hard by design, which
 * is the point.
 */
export async function hashPassword(plaintext: string): Promise<string> {
  return argon2.hash(plaintext, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, plaintext: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plaintext);
  } catch {
    // A malformed/foreign hash format should fail closed, not throw past
    // the caller and risk being mistaken for a transient error.
    return false;
  }
}
