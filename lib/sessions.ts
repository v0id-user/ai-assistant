// Conversations, so a session can be reloaded after the tab closes.
// A sorted set indexes sessions by last activity; one list holds each
// session's turns.

import { redis } from "@/lib/redis";

const INDEX = "sarjy:sessions";
const TTL_SECONDS = 60 * 60 * 24 * 30; // matches the fact TTL
const MAX_SESSIONS = 30;

export type StoredTurn = { role: "user" | "assistant"; text: string };
export type SessionSummary = { sessionId: string; at: number; preview: string };

function turnsKey(sessionId: string) {
  return `sarjy:turns:${sessionId}`;
}

export async function recordTurns(
  sessionId: string,
  turns: StoredTurn[],
  at: number,
): Promise<void> {
  const r = redis();
  const key = turnsKey(sessionId);
  await r.rpush(key, ...turns.map((t) => JSON.stringify(t)));
  await r.expire(key, TTL_SECONDS);
  await r.zadd(INDEX, { score: at, member: sessionId });
  // Keep the index from growing without bound; oldest sessions drop off.
  await r.zremrangebyrank(INDEX, 0, -(MAX_SESSIONS + 1));
  await r.expire(INDEX, TTL_SECONDS);
}

export async function getTurns(sessionId: string): Promise<StoredTurn[]> {
  const raw = await redis().lrange<StoredTurn | string>(turnsKey(sessionId), 0, -1);
  return raw.map((e) => (typeof e === "string" ? JSON.parse(e) : e));
}

export async function listSessions(): Promise<SessionSummary[]> {
  const r = redis();
  const entries = await r.zrange<(string | number)[]>(INDEX, 0, MAX_SESSIONS - 1, {
    rev: true,
    withScores: true,
  });

  const summaries: SessionSummary[] = [];
  for (let i = 0; i < entries.length; i += 2) {
    const sessionId = String(entries[i]);
    const at = Number(entries[i + 1]);
    // First user turn doubles as the label for the session.
    const [first] = await r.lrange<StoredTurn | string>(turnsKey(sessionId), 0, 0);
    const parsed = typeof first === "string" ? JSON.parse(first) : first;
    summaries.push({ sessionId, at, preview: parsed?.text ?? "(empty)" });
  }
  return summaries;
}
