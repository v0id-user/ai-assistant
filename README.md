# Sarjy

A browser voice assistant. You talk to it, it answers out loud, it remembers
what you told it in earlier sessions, and it can pull live weather.

Built to the scope in [`docs/tdd.md`](docs/tdd.md) section 2. The section 6
semantic cache is deliberately not built.

## How it works

    mic (Web Speech API) -> /api/chat -> /api/tts -> <audio>

- **STT** runs in the browser via the Web Speech API, with interim results
  streamed into the UI as you speak.
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

Two things need doing once before it will talk:

1. **Accept the Groq TTS model terms.** The TTS route returns
   `model_terms_required` until an org admin accepts them at
   https://console.groq.com/playground?model=canopylabs%2Forpheus-v1-english
2. **Create an Upstash Redis database** and paste both values above. Without
   them `/api/chat` fails on the memory load.

Use Chrome or Edge on desktop. The Web Speech API is not available everywhere,
and the page says so if it is missing.

## Timing

Every stage boundary is marked with `performance.now()` and the deltas are
logged. Server-side, per request:

    [chat] total=1918.4ms memory_load=+2.6ms llm_round_0=+478.9ms tools_round_0=+909.9ms llm_round_1=+527ms
    [tts]  total=812.0ms tts_first_byte=+790.1ms tts_complete=+21.9ms

Client-side, in the browser console, covering the full round trip through to
playback start:

    [client] llm=+1918.4ms tts=+812.0ms playback=+3.1ms total=2733.5ms

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
- The LLM is `openai/gpt-oss-120b` (override with `GROQ_MODEL`). The TDD did
  not pin a model, and the Llama models the Groq docs recommend for tool use
  are not served on this account.
