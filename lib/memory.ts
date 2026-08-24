// Facts the user stated about themselves, keyed by the cookie owner rather
// than the conversation: they describe the person, so they outlive any single
// chat session. Turns stay per session. A Redis set dedupes repeats for free
// and reads are one round trip.

import { redis } from "@/lib/redis";

const FACT_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const MAX_FACTS = 50;

function key(ownerId: string) {
  return `sarjy:facts:${ownerId}`;
}

export async function getFacts(ownerId: string): Promise<string[]> {
  const facts = await redis().smembers<string[]>(key(ownerId));
  return facts.slice(0, MAX_FACTS);
}

export async function saveFact(ownerId: string, fact: string): Promise<void> {
  const k = key(ownerId);
  await redis().sadd(k, fact);
  await redis().expire(k, FACT_TTL_SECONDS);
}
