// Semantic cache: match an incoming question by meaning, and on a hit return
// the stored answer and audio, skipping both the LLM and TTS.
//
// One Upstash Vector index with hosted embedding. Two kinds of entry, matched
// at different thresholds:
//   canned  — hand-seeded, loose threshold (a wrong hit is harmless)
//   learned — written back per owner, tight threshold (a wrong hit leaks
//             another answer's facts)

import { Index } from "@upstash/vector";

import { audioKey } from "@/lib/audio";

let index: Index | null = null;
function vector(): Index {
  if (!index) index = Index.fromEnv();
  return index;
}

// Tuned by the threshold experiment (scripts/threshold.mjs). Cosine similarity.
const CANNED_THRESHOLD = Number(process.env.CACHE_CANNED_THRESHOLD ?? "0.72");
const LEARNED_THRESHOLD = Number(process.env.CACHE_LEARNED_THRESHOLD ?? "0.90");

type CacheMeta = {
  answer: string;
  audio: string; // audioKey of the answer text
  kind: "canned" | "learned";
  ownerId?: string;
};

export type CacheHit = { text: string; audioRef: string; kind: string; score: number };

export async function lookup(
  question: string,
  ownerId: string,
): Promise<CacheHit | null> {
  const [match] = await vector().query({
    data: question,
    topK: 1,
    includeMetadata: true,
    // Only this owner's learned entries, or any canned entry.
    filter: `kind = 'canned' OR ownerId = '${ownerId}'`,
  });
  if (!match?.metadata) return null;

  const meta = match.metadata as CacheMeta;
  const threshold =
    meta.kind === "canned" ? CANNED_THRESHOLD : LEARNED_THRESHOLD;
  if (match.score < threshold) return null;

  return {
    text: meta.answer,
    audioRef: meta.audio,
    kind: meta.kind,
    score: match.score,
  };
}

export async function learn(
  question: string,
  answer: string,
  ownerId: string,
): Promise<void> {
  await vector().upsert([
    {
      // Deterministic id so the same question overwrites rather than piles up.
      id: `learned:${ownerId}:${question.trim().toLowerCase()}`,
      data: question,
      metadata: {
        answer,
        audio: audioKey(answer),
        kind: "learned",
        ownerId,
      },
    },
  ]);
}
