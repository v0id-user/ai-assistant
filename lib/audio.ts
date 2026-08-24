// Synthesised audio, stored so a cache hit can replay it instead of calling
// TTS again. Keyed by a hash of the reply text: the same reply always maps to
// the same key, so the TTS route can populate it as a side effect and the
// cache can reference it without coordinating.

import { createHash } from "crypto";

import { redis } from "@/lib/redis";

const TTL_SECONDS = 60 * 60 * 24; // a day; the free TTS tier is tight on storage

export function audioKey(text: string): string {
  return `sarjy:audio:${createHash("sha256").update(text.trim()).digest("hex").slice(0, 16)}`;
}

export async function putAudio(text: string, wav: ArrayBuffer): Promise<void> {
  const b64 = Buffer.from(wav).toString("base64");
  await redis().set(audioKey(text), b64, { ex: TTL_SECONDS });
}

export async function getAudio(key: string): Promise<string | null> {
  return redis().get<string>(key);
}
