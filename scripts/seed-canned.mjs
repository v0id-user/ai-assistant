// Seed canned cache entries with pre-generated audio. Idempotent: fixed ids.
// Only generic exchanges where any reasonable answer fits, so a loose match
// (0.72) never serves a wrong specific answer. Nothing with a number or entity.
import { Index } from "@upstash/vector";
import { Redis } from "@upstash/redis";
import Groq from "groq-sdk";
import { createHash } from "crypto";

const ix = Index.fromEnv();
const redis = Redis.fromEnv();
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const audioKey = (t) => `sarjy:audio:${createHash("sha256").update(t.trim()).digest("hex").slice(0,16)}`;

const CANNED = [
  ["Hello, how are you?", "I'm doing well, thanks for asking!"],
  ["Hi there.", "Hello! Good to hear from you."],
  ["Good morning.", "Good morning to you!"],
  ["How are you doing?", "I'm doing great, thanks!"],
  ["What is your name?", "I'm Sarjy, your voice assistant."],
  ["Who are you?", "I'm Sarjy, a voice assistant."],
  ["What can you help me with?", "I can chat, remember what you tell me, and check the weather."],
  ["What can you do?", "I can answer questions, remember facts about you, and give you the weather."],
  ["Thank you.", "You're very welcome!"],
  ["Thanks a lot.", "Anytime, happy to help!"],
  ["Goodbye.", "Goodbye, talk to you soon!"],
  ["Nice to meet you.", "Nice to meet you too!"],
];

let audioOk = 0, audioFail = 0, skipped = 0;
for (const [q, a] of CANNED) {
  let stored = false;
  // Skip synthesis if this answer's audio is already stored, so a re-run only
  // spends TTS quota on what is missing.
  if (await redis.get(audioKey(a))) {
    skipped++;
    await ix.upsert([{ id:`canned:${q.toLowerCase()}`, data:q, metadata:{ answer:a, audio:audioKey(a), kind:"canned" } }]);
    console.log(`[have ] "${q}"`);
    continue;
  }
  try {
    const speech = await groq.audio.speech.create({ model:"canopylabs/orpheus-v1-english", voice:"hannah", input:a, response_format:"wav" });
    const buf = Buffer.from(await speech.arrayBuffer());
    await redis.set(audioKey(a), buf.toString("base64"), { ex: 60*60*24*30 });
    stored = true; audioOk++;
  } catch (e) {
    audioFail++;
    if (/rate.?limit|429/i.test(String(e.message||e))) { console.log("TTS rate limited, seeding rest text-only"); }
  }
  await ix.upsert([{ id:`canned:${q.toLowerCase()}`, data:q, metadata:{ answer:a, audio:audioKey(a), kind:"canned" } }]);
  console.log(`${stored?"[audio]":"[text ]"} "${q}"`);
}
console.log(`\nseeded ${CANNED.length} canned entries. audio: ${audioOk} new, ${skipped} already had audio, ${audioFail} still missing.`);
