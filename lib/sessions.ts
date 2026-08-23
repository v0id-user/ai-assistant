// Conversations, owned by the browser that created them. Every key is scoped
// to the owner id from the cookie; there is no global session index.

import { redis } from "@/lib/redis";

const TTL_SECONDS = 60 * 60 * 24 * 30; // matches the fact TTL
const MAX_SESSIONS = 30;

export type StoredTurn = { role: "user" | "assistant"; text: string };
export type SessionSummary = { sessionId: string; at: number; preview: string };

const indexKey = (ownerId: string) => `sarjy:owner:${ownerId}:sessions`;
const currentKey = (ownerId: string) => `sarjy:owner:${ownerId}:current`;
const turnsKey = (sessionId: string) => `sarjy:turns:${sessionId}`;

export async function ownsSession(ownerId: string, sessionId: string) {
  const score = await redis().zscore(indexKey(ownerId), sessionId);
  return score !== null;
}

export async function startSession(ownerId: string): Promise<string> {
  const sessionId = crypto.randomUUID();
  const r = redis();
  await r.zadd(indexKey(ownerId), { score: Date.now(), member: sessionId });
  await r.set(currentKey(ownerId), sessionId, { ex: TTL_SECONDS });
  await r.expire(indexKey(ownerId), TTL_SECONDS);
  return sessionId;
}

export async function getCurrentSessionId(ownerId: string): Promise<string> {
  const current = await redis().get<string>(currentKey(ownerId));
  if (current) return current;
  return startSession(ownerId);
}

// Only switches to a session the caller actually owns.
export async function selectSession(ownerId: string, sessionId: string) {
  if (!(await ownsSession(ownerId, sessionId))) return false;
  await redis().set(currentKey(ownerId), sessionId, { ex: TTL_SECONDS });
  return true;
}

export async function recordTurns(
  ownerId: string,
  sessionId: string,
  turns: StoredTurn[],
  at: number,
): Promise<void> {
  const r = redis();
  const key = turnsKey(sessionId);
  await r.rpush(key, ...turns.map((t) => JSON.stringify(t)));
  await r.expire(key, TTL_SECONDS);
  await r.zadd(indexKey(ownerId), { score: at, member: sessionId });
  await r.zremrangebyrank(indexKey(ownerId), 0, -(MAX_SESSIONS + 1));
  await r.expire(indexKey(ownerId), TTL_SECONDS);
}

export async function getTurns(sessionId: string): Promise<StoredTurn[]> {
  const raw = await redis().lrange<StoredTurn | string>(turnsKey(sessionId), 0, -1);
  return raw.map((e) => (typeof e === "string" ? JSON.parse(e) : e));
}

export async function listSessions(ownerId: string): Promise<SessionSummary[]> {
  const r = redis();
  const entries = await r.zrange<(string | number)[]>(
    indexKey(ownerId),
    0,
    MAX_SESSIONS - 1,
    { rev: true, withScores: true },
  );

  const summaries: SessionSummary[] = [];
  for (let i = 0; i < entries.length; i += 2) {
    const sessionId = String(entries[i]);
    const at = Number(entries[i + 1]);
    const [first] = await r.lrange<StoredTurn | string>(turnsKey(sessionId), 0, 0);
    const parsed = typeof first === "string" ? JSON.parse(first) : first;
    summaries.push({ sessionId, at, preview: parsed?.text ?? "(empty)" });
  }
  return summaries;
}
