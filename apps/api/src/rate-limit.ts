import type { Redis } from "ioredis";
import { RateLimitedError } from "@app/shared";

/**
 * Fixed-window counter in Redis - simpler than a true token bucket and
 * sufficient for the layered per-IP/per-tenant/per-API-key limiting in
 * docs/SECURITY.md §8. One INCR + conditional EXPIRE per check, atomic via
 * a single round trip's worth of Lua-free composition (INCR is itself
 * atomic; the EXPIRE only fires on the first hit in a window).
 */
export async function checkRateLimit(
  redis: Redis,
  args: { scope: "IP" | "TENANT" | "API_KEY"; key: string; limit: number; windowSeconds: number },
): Promise<void> {
  const redisKey = `ratelimit:${args.scope}:${args.key}`;
  const count = await redis.incr(redisKey);
  if (count === 1) {
    await redis.expire(redisKey, args.windowSeconds);
  }
  if (count > args.limit) {
    const ttl = await redis.ttl(redisKey);
    throw new RateLimitedError(args.scope, ttl > 0 ? ttl : args.windowSeconds);
  }
}
