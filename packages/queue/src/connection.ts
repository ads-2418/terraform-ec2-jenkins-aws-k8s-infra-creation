import { Redis } from "ioredis";

/** BullMQ requires this exact option - it manages its own retry logic and blocking commands. */
export function createQueueRedisConnection(redisUrl: string): Redis {
  return new Redis(redisUrl, { maxRetriesPerRequest: null });
}
