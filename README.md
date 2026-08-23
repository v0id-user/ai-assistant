# Sarjy

A browser voice assistant. You talk to it, it answers out loud, it remembers
what you told it in earlier sessions, and it can pull live weather.

Built to the scope in [`docs/tdd.md`](docs/tdd.md) section 2. The section 6
semantic cache is deliberately not built.

## How it works

    mic (MediaRecorder) -> /api/stt -> /api/chat -> /api/tts -> <audio>

- **STT** records with `MediaRecorder` and posts the clip to `/api/stt`, which
  transcribes it with Groq Whisper. The container is probed with
  `isTypeSupported` (webm/opus, ogg/opus or mp4 depending on browser) and Groq
  accepts all of them, so nothing is transcoded.
- **`/api/chat`** takes `{ transcript, sessionId, history }`, loads that
  session's stored facts from Upstash, injects them into the system prompt, and
  calls Groq with two tools: `save_fact` and `get_weather`. Returns the reply
  text plus the message log, which the client replays on the next turn to keep
  conversation history within the session.
- **`/api/tts`** turns reply text into a wav via Groq TTS.
- **Memory** is a Redis set per session id, so repeated facts dedupe and reads
  are one round trip. 30 day TTL.

| File | Does |
|---|---|
| `app/page.tsx` | Mic button, transcript, audio playback |
| `app/api/stt/route.ts` | Audio to text |
| `app/api/chat/route.ts` | Memory + LLM + tools |
| `app/api/tts/route.ts` | Text to audio |
| `lib/memory.ts` | Get/save facts by session id |
| `lib/weather.ts` | Open-Meteo fetch |
| `lib/timing.ts` | Stage-boundary marks |

## Setup

```bash
npm install
cp .env.example .env
npm run dev
```

Fill in `.env`:

- `GROQ_API_KEY` — from https://console.groq.com/keys
- `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` — from
  https://console.upstash.com

One thing needs doing before it will talk:

**Create an Upstash Redis database** and paste both values above. Without them
`/api/chat` fails on the memory load. (The Groq TTS model terms are already
accepted on this account.)

Single visual theme: a warm cream ground with a fine grain overlay. There is
no light/dark switching by design.

Any current desktop browser works, including Brave, Firefox and Safari. STT
runs server side precisely so it does not depend on browser speech support.

## Timing

Every stage boundary is marked with `performance.now()` and the deltas are
logged. Server-side, per request:

    [stt]  total=310.5ms transcribe=+310.5ms
    [chat] total=1278.3ms memory_load=+442ms llm_round_0=+836.2ms
    [tts]  total=609.1ms tts_first_byte=+168.2ms tts_complete=+440.9ms

Client-side, in the browser console, covering the full round trip through to
playback start:

    [client] stt=+310ms llm=+1278ms tts=+609ms playback=+…ms total=…ms

`/api/chat` also returns its `timings` in the response body.

## Deploying to Vercel

Push the repo, import it in Vercel, and set `GROQ_API_KEY`,
`UPSTASH_REDIS_REST_URL`, and `UPSTASH_REDIS_REST_TOKEN` as environment
variables. No other configuration is needed — both routes are standard Node
route handlers.

## Deviations from the TDD

- The TDD names **PlayAI** for TTS. Groq has since retired those models; the
  live TTS family is Orpheus, so this uses `canopylabs/orpheus-v1-english`.
  Override with `GROQ_TTS_MODEL` / `GROQ_TTS_VOICE`.
- **STT moved off the browser Web Speech API to Groq Whisper.** Brave ships
  `webkitSpeechRecognition` but disables the backend, and it cannot be feature
  detected. Section 2's "Streaming STT" is dropped as a result: Groq
  transcription is batch only. See the amendment in `docs/tdd.md`.
- The LLM is `openai/gpt-oss-120b` (override with `GROQ_MODEL`). The TDD did
  not pin a model, and the Llama models the Groq docs recommend for tool use
  are not served on this account.
