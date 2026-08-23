import Groq from "groq-sdk";

import { createTimer } from "@/lib/timing";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// whisper-large-v3 over -turbo: at the two-to-six second utterances this app
// records, the two are indistinguishable on latency, so the lower word error
// rate wins. Transcripts feed save_fact, where a misheard name sticks around.
const MODEL = process.env.GROQ_STT_MODEL ?? "whisper-large-v3";

export async function POST(request: Request) {
  const timer = createTimer("stt");

  const form = await request.formData();
  const audio = form.get("audio");

  if (!(audio instanceof File)) {
    return Response.json({ error: "audio file is required" }, { status: 400 });
  }

  try {
    // Groq infers the container from the filename, and which container we get
    // depends on the browser, so carry the recorded type through rather than
    // hardcoding an extension.
    const transcription = await groq.audio.transcriptions.create({
      file: audio,
      model: MODEL,
      response_format: "json",
    });
    timer.mark("transcribe");
    const timings = timer.done();

    return Response.json({ text: transcription.text.trim(), timings });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[stt] failed:", message);
    return Response.json({ error: message }, { status: 502 });
  }
}
