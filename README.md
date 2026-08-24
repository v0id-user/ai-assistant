# Sarjy

A browser voice assistant. You talk to it, it answers out loud, it remembers
what you told it in earlier sessions, and it can pull live weather.

**Live: [sarjy-voice.vercel.app](https://sarjy-voice.vercel.app)**

It also has a semantic cache: repeat questions are matched by meaning rather
than exact string, and a hit skips both the LLM and text to speech. On a small
sample from the deployed app, a hit could answer in roughly 300ms where a miss
took around 1.5s.

Design notes and measurements are in [`docs/tdd.md`](docs/tdd.md).

## How it works

    mic (MediaRecorder) -> /api/stt -> /api/chat -> /api/tts -> <audio>
                                          |
                                          +- cache hit: stored text + audio,
                                             no LLM, no TTS

- **STT**: the browser records the clip, the server transcribes it with Groq
  Whisper. Nothing depends on browser speech support.
- **Chat**: loads what is remembered about you, calls Groq with two tools
  (`save_fact` and `get_weather`), and returns the reply.
- **TTS**: turns the reply into audio.
- **Memory** is keyed to a cookie, so it outlives any single conversation.

| File | Does |
|---|---|
| `app/page.tsx` | Mic button, transcript, audio playback |
| `app/api/stt/route.ts` | Audio to text |
| `app/api/chat/route.ts` | Memory + LLM + tools |
| `app/api/tts/route.ts` | Text to audio |
| `lib/memory.ts` | Get/save facts, keyed to the cookie owner |
| `lib/cache.ts` | Semantic cache lookup and write back |
| `lib/llm.ts` | Tool loop and the spoken-reply call |
| `lib/prompt.ts` | System prompt and message assembly |
| `lib/tools.ts` | Tool definitions and dispatch |
| `lib/identity.ts` | Cookie-based owner id |
| `lib/sessions.ts` | Conversations and the session index |
| `lib/traces.ts` | Per-turn trace records |
| `lib/audio.ts` | Stored TTS audio for cache hits |
| `lib/redis.ts` | Shared Upstash Redis client |
| `lib/weather.ts` | Open-Meteo fetch |
| `lib/timing.ts` | Stage-boundary marks |

## Setup

```bash
npm install
cp .env.example .env   # then fill in the keys below
npm run dev
```

- `GROQ_API_KEY` from [console.groq.com](https://console.groq.com/keys)
- `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` from
  [console.upstash.com](https://console.upstash.com), for memory and traces
- `UPSTASH_VECTOR_REST_URL` and `UPSTASH_VECTOR_REST_TOKEN` from the same
  place, for the semantic cache

Any current desktop browser works.

## Semantic cache

One Upstash Vector index with hosted embedding, so there is no separate
embedding provider. Lookup runs before anything expensive, and write back
happens after the response is already sent, so caching costs the turn nothing.

Two kinds of entry, held to different thresholds:

- **canned**: hand seeded generic exchanges (greetings, identity,
  capabilities), matched loosely. Any reasonable answer fits, so a near miss
  is harmless.
- **learned**: written back per cookie owner after a miss, matched tightly. A
  loose match here could serve one answer's personal facts for a differently
  meant question, so it is near exact only.

That gap is deliberate. Paraphrases and near misses overlap more than they
look like they should, and the thresholds were picked by scoring hand written
pairs rather than guessed. The numbers and the failure case are in
[`docs/tdd.md`](docs/tdd.md).

Weather bypasses the cache, since the answer goes stale within the hour.

## Observability

Every stage boundary is marked with `performance.now()`, so each turn carries a
breakdown of where its time went: transcription, memory load, each LLM call and
tool run, and speech synthesis. The server logs it, the response body carries
it, and the browser console prints the client side view including playback.

`/_debug/traces` shows the last 50 turns for your cookie, grouped by
conversation, with the stage timings, the tool calls and their arguments, token
usage, whether the turn was a cache hit, and the exact payload sent to the
model. There is a button to copy the whole thing as markdown.

## Deploying to Vercel

Push the repo, import it in Vercel, and set `GROQ_API_KEY`,
`UPSTASH_REDIS_REST_URL`, and `UPSTASH_REDIS_REST_TOKEN` as environment
variables. No other configuration is needed, both routes are standard Node
route handlers.
