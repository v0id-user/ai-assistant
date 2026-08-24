// Turn traces for the debug page. A capped Redis list, newest first.
// Vercel is ephemeral, so this cannot live in process memory.

import { redis } from "@/lib/redis";
import { listSessions } from "@/lib/sessions";

const traceKey = (sessionId: string) => `sarjy:traces:${sessionId}`;
const MAX_TRACES = 50;
const TTL_SECONDS = 60 * 60 * 24; // a day is plenty for a demo aid

export type ToolCall = { round: number; name: string; args: string; result: string };

export type Trace = {
  at: string;
  sessionId: string;
  transcript: string;
  response: string;
  tools?: ToolCall[];
  cached?: boolean;
  cacheKind?: string;
  // Summed across every LLM call in the turn. `cached` is the prefix-cache
  // hit reported by Groq; 0 means the prompt prefix was not reused.
  tokens?: { prompt: number; completion: number; cached: number };
  // Exactly what was sent to the LLM for this turn, for debugging.
  request?: { role: string; content: string }[];
  timings: { totalMs: number; stages: { name: string; deltaMs: number }[] };
};

export async function saveTrace(trace: Trace): Promise<void> {
  const r = redis();
  const key = traceKey(trace.sessionId);
  await r.lpush(key, JSON.stringify(trace));
  await r.ltrim(key, 0, MAX_TRACES - 1);
  await r.expire(key, TTL_SECONDS);
}

// Every trace this owner has, newest first, tagged with its session.
export async function getTracesForOwner(ownerId: string): Promise<Trace[]> {
  const sessions = await listSessions(ownerId);
  const perSession = await Promise.all(
    sessions.map((s) => getTraces(s.sessionId)),
  );
  return perSession.flat().sort((a, b) => b.at.localeCompare(a.at));
}

export async function getTraces(sessionId: string): Promise<Trace[]> {
  // The SDK parses JSON strings back into objects on read, so accept either.
  const raw = await redis().lrange<Trace | string>(
    traceKey(sessionId),
    0,
    MAX_TRACES - 1,
  );
  return raw.map((entry) =>
    typeof entry === "string" ? (JSON.parse(entry) as Trace) : entry,
  );
}
