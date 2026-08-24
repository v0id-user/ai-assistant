// Score hand-written pairs to pick cache thresholds from data, not a guess.
// Upserts each reference question, queries the variant, reads cosine score.
import { Index } from "@upstash/vector";
const ix = Index.fromEnv();

const PAIRS = [
  // [reference, variant, shouldHit]
  ["What is my favourite colour?", "which colour do I like best", true],
  ["What is my favourite colour?", "what colour do I prefer", true],
  ["Where do I live?", "tell me where I live", true],
  ["Where do I live?", "which city am I in", true],
  ["What is my name?", "remind me what my name is", true],
  ["What can you help me with?", "what are you able to do", true],
  ["Tell me a fun fact.", "share an interesting fact", true],
  ["How are you?", "how are you doing today", true],
  ["What is your name?", "who are you", true],
  ["Count to five.", "please count to 5", true],
  // near misses that must NOT hit
  ["What is the weather in Jeddah?", "what is the weather in Riyadh", false],
  ["What is my favourite colour?", "what is my favourite food", false],
  ["Where do I live?", "where do you live", false],
  ["What is my name?", "what is your name", false],
  ["Tell me a fun fact.", "tell me the weather", false],
  ["My name is Fahad.", "what is my name", false],
  ["I live in Jeddah.", "where do I live", false],
  ["What can you help me with?", "what is the capital of France", false],
  ["How are you?", "how do I get there", false],
  ["Count to five.", "count to one hundred", false],
];

const scores = [];
for (let i = 0; i < PAIRS.length; i++) {
  const [ref, variant, shouldHit] = PAIRS[i];
  const id = `thr:${i}`;
  await ix.upsert([{ id, data: ref, metadata: {} }]);
  await new Promise((r) => setTimeout(r, 300));
  const [m] = await ix.query({ data: variant, topK: 1, filter: `id = '${id}'`.replace("id","") ? undefined : undefined });
  // query without filter, then match our id
  const res = await ix.query({ data: variant, topK: 3, includeVectors: false });
  const own = res.find((x) => x.id === id);
  scores.push({ ref, variant, shouldHit, score: own ? own.score : (m?.score ?? 0) });
  await ix.delete(id);
}

const hits = scores.filter((s) => s.shouldHit).map((s) => s.score).sort((a,b)=>a-b);
const miss = scores.filter((s) => !s.shouldHit).map((s) => s.score).sort((a,b)=>b-a);
console.log("PARAPHRASES (should hit), sorted low->high:");
scores.filter(s=>s.shouldHit).sort((a,b)=>a.score-b.score).forEach(s=>console.log(`  ${s.score.toFixed(3)}  "${s.variant}"`));
console.log("NEAR MISSES (should not hit), sorted high->low:");
scores.filter(s=>!s.shouldHit).sort((a,b)=>b.score-a.score).forEach(s=>console.log(`  ${s.score.toFixed(3)}  "${s.variant}"`));
console.log(`\nlowest paraphrase: ${hits[0].toFixed(3)}   highest near-miss: ${miss[0].toFixed(3)}`);

// sweep thresholds
console.log("\nthreshold | true-hit | false-hit");
for (const t of [0.60,0.65,0.70,0.72,0.75,0.78,0.80,0.82,0.85,0.88]) {
  const th = scores.filter(s=>s.shouldHit && s.score>=t).length;
  const fh = scores.filter(s=>!s.shouldHit && s.score>=t).length;
  console.log(`  ${t.toFixed(2)}    |  ${th}/10   |  ${fh}/10`);
}
