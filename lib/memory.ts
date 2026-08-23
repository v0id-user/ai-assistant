// Facts the user stated about themselves, keyed by session id.
// A Redis set per session: dedupes repeats for free, and reads are one round trip.

import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

const FACT_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const MAX_FACTS = 50;

function key(sessionId: string) {
  return `sarjy:facts:${sessionId}`;
}

export async function getFacts(sessionId: string): Promise<string[]> {
  const facts = await redis.smembers<string[]>(key(sessionId));
  return facts.slice(0, MAX_FACTS);
}

export async function saveFact(sessionId: string, fact: string): Promise<void> {
  const k = key(sessionId);
  await redis.sadd(k, fact);
  await redis.expire(k, FACT_TTL_SECONDS);
}
