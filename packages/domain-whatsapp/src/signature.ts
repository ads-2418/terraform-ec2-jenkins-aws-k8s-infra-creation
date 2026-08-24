import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Meta's webhook signature - docs/SECURITY.md §7. The header is
 * `sha256=<hex>`, an HMAC-SHA256 of the *raw* request body (not the
 * parsed/re-serialized JSON, which can differ byte-for-byte) using the
 * app secret. Verified before anything else touches the payload -
 * apps/api's webhook route calls this on the raw body string/buffer it
 * received, prior to JSON.parse.
 */
export function verifyWhatsAppSignature(args: {
  rawBody: string | Buffer;
  signatureHeader: string | undefined;
  appSecret: string;
}): boolean {
  if (!args.signatureHeader?.startsWith("sha256=")) return false;

  const expectedHex = args.signatureHeader.slice("sha256=".length);
  const expected = Buffer.from(expectedHex, "hex");

  const computed = createHmac("sha256", args.appSecret).update(args.rawBody).digest();

  // Different-length buffers would throw inside timingSafeEqual rather
  // than compare - a malformed/short header is just an invalid signature.
  if (expected.length !== computed.length) return false;

  return timingSafeEqual(expected, computed);
}
