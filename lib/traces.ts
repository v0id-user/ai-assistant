// Turn traces for the debug page. A capped Redis list, newest first.
// Vercel is ephemeral, so this cannot live in process memory.

import { redis } from "@/lib/redis";

const KEY = "sarjy:traces";
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
  await r.lpush(KEY, JSON.stringify(trace));
  await r.ltrim(KEY, 0, MAX_TRACES - 1);
  await r.expire(KEY, TTL_SECONDS);
}

export async function getTraces(): Promise<Trace[]> {
  // The SDK parses JSON strings back into objects on read, so accept either.
  const raw = await redis().lrange<Trace | string>(KEY, 0, MAX_TRACES - 1);
  return raw.map((entry) =>
    typeof entry === "string" ? (JSON.parse(entry) as Trace) : entry,
  );
}
