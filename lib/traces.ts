// Turn traces for the debug page. A capped Redis list, newest first.
// Vercel is ephemeral, so this cannot live in process memory.

import { redis } from "@/lib/redis";

const traceKey = (sessionId: string) => `sarjy:traces:${sessionId}`;
const MAX_TRACES = 50;
const TTL_SECONDS = 60 * 60 * 24; // a day is plenty for a demo aid

export type Trace = {
  at: string;
  sessionId: string;
  transcript: string;
  response: string;
  timings: { totalMs: number; stages: { name: string; deltaMs: number }[] };
};

export async function saveTrace(trace: Trace): Promise<void> {
  const r = redis();
  const key = traceKey(trace.sessionId);
  await r.lpush(key, JSON.stringify(trace));
  await r.ltrim(key, 0, MAX_TRACES - 1);
  await r.expire(key, TTL_SECONDS);
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
