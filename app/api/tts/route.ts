import Groq from "groq-sdk";

import { after } from "next/server";

import { createTimer } from "@/lib/timing";
import { putAudio } from "@/lib/audio";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Orpheus is the TTS family Groq currently serves; PlayAI (named in the TDD)
// has since been retired. Orpheus only emits wav.
const MODEL = process.env.GROQ_TTS_MODEL ?? "canopylabs/orpheus-v1-english";
const VOICE = process.env.GROQ_TTS_VOICE ?? "hannah";

export async function POST(request: Request) {
  const timer = createTimer("tts");

  const { text } = await request.json();

  if (!text) {
    return Response.json({ error: "text is required" }, { status: 400 });
  }

  let audio: ArrayBuffer;
  try {
    const speech = await groq.audio.speech.create({
      model: MODEL,
      voice: VOICE,
      input: text,
      response_format: "wav",
    });
    timer.mark("tts_first_byte");
    audio = await speech.arrayBuffer();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[tts] failed:", message);
    return Response.json({ error: message }, { status: 502 });
  }
  timer.mark("tts_complete");
  const timings = timer.done();

  // Store what we just synthesised so a future cache hit on this reply can
  // replay it instead of calling TTS again. Off the response path.
  after(() => putAudio(text, audio).catch(() => {}));

  return new Response(audio, {
    headers: {
      "Content-Type": "audio/wav",
      "Content-Length": String(audio.byteLength),
      // The body is audio, so the stage marks travel in a header.
      "X-Timings": JSON.stringify(timings),
    },
  });
}
