// Facts the user stated about themselves, keyed by the cookie owner rather
// than the conversation: they describe the person, so they outlive any single
// chat session. Turns stay per session.
//
// A hash rather than a set, so a new fact about the same subject replaces the
// old one instead of both coexisting. The subject is the hash field.

import { redis } from "@/lib/redis";

const FACT_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const MAX_FACTS = 50;

function key(ownerId: string) {
  return `sarjy:facts:${ownerId}`;
}

export async function getFacts(ownerId: string): Promise<string[]> {
  const stored = await redis().hgetall<Record<string, string>>(key(ownerId));
  if (!stored) return [];
  return Object.values(stored).slice(0, MAX_FACTS);
}

export async function saveFact(
  ownerId: string,
  subject: string,
  fact: string,
): Promise<void> {
  const k = key(ownerId);
  // Normalised so "Favourite colour" and "favourite colour" are one subject.
  await redis().hset(k, { [subject.trim().toLowerCase()]: fact });
  await redis().expire(k, FACT_TTL_SECONDS);
}

export async function clearFacts(ownerId: string): Promise<void> {
  await redis().del(key(ownerId));
}
