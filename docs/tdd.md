# Sarjy - Technical Design

## 1. What I'm building

Sarjy is a browser based voice assistant. You talk to it, it answers out loud,
it remembers things you told it in earlier sessions, and it can pull live
weather when you ask.

## 2. Scope

**In:**
- Voice in, voice out
- Memory across sessions (facts the user states about themselves)
- Conversation history within a session
- Speech to text on every desktop browser
- One external API (weather)
- Deployed and publicly reachable

**Out (and why):**
- No authentication or multi user support. Identity is an httpOnly cookie set
  server side, which scopes sessions, facts and traces to one browser. That is
  not auth and does not survive clearing cookies; it exists because the demo is
  a public URL and the original single-demo-user assumption did not hold.
- No mobile specific UI. Desktop browser only, keeps the surface small.
- No error recovery beyond basic failure states. Out of scope for a demo.
- No self hosted vector store. Using Upstash so the storage question does not
  eat the time budget.
- No real observability stack. Timing logs are enough to make latency
  measurable.

## 3. Architecture

    voice in -> STT -> semantic cache lookup
                         |- hit  -> cached answer + cached audio
                         |- miss -> LLM (+ weather tool) -> TTS -> audio out

**Key decisions:**

| Decision | Choice | Why | Alternative rejected |
|---|---|---|---|
| STT | Whisper on Groq (`whisper-large-v3`) | Works in every browser; Web Speech does not | Browser Web Speech API, unusable in Brave and Firefox |
| LLM | Groq | Fastest time to first token, which is what the deep dive is about | OpenAI, slower first token |
| LLM model | `openai/gpt-oss-20b` | Measured against every chat model on the account | `gpt-oss-120b`, slower and leaked reasoning |
| TTS | Provider API (Groq PlayAI) | Returns real audio files, so responses can be cached and measured | Browser speechSynthesis, not measurable and not cacheable |
| Storage and cache | Upstash | Managed, no infra work, vector and KV in one place | Self hosted Redis or pgvector, too much setup for the time budget |

### Amendment: STT moved off the Web Speech API

Originally this was the browser Web Speech API, chosen for zero setup. First
real test failed: Brave ships `webkitSpeechRecognition` but disables the
backend, so it throws `network` at runtime. Google licenses its speech service
to Chrome only, and Brave, Firefox and Chromium builds get nothing. The
constructor still exists, so there is no way to feature detect it, and the
unsupported-browser banner cannot fire. This is the risk section 7 already
listed as "browser STT support varies across browsers".

Two consequences:

- **"Streaming STT" is dropped from section 2.** Groq transcription is batch
  only. This was verified at the type level: `@ai-sdk/groq` exposes
  `TranscriptionModelV4`, and the AI SDK's `streamTranscribe` has no Groq
  implementation. No layer recovers it, so there is no live partial transcript.
- **Roughly 400ms of serial latency is added** to every turn. Web Speech
  transcribed while the user spoke and cost nothing; Whisper runs after they
  stop. The trade was made knowingly: a demo that only works in one browser is
  worth less than 400ms.

`whisper-large-v3` over `-turbo` because at 2 to 6 second utterances the two
are indistinguishable on latency, measured, so the lower word error rate
(10.3% against 12%) decides it. Transcripts feed the memory tool, where a
misheard name persists for 30 days.

### Model comparison

The LLM was originally picked on one smoke test, which was not good enough.
Ten fixed prompts covering all four behaviours were then run against every
chat capable model on the account, with identical settings.

| Model | Turns | Latency median / p95 | Tool correctness | Reasoning leak | Format |
|---|---|---|---|---|---|
| `openai/gpt-oss-20b` | 10/10 | 528ms / 1336ms | 9/10 | 0/10 | 9/10 |
| `openai/gpt-oss-120b` | 10/10 | 750ms / 2112ms | 8/10 | 1/10 | 9/10 |
| `qwen/qwen3.6-27b` | 6/10 | 725ms / 1493ms | 6/6 | 0/6 | 6/6 |
| `groq/compound`, `-mini` | 0/10 | n/a | n/a | n/a | n/a |

`gpt-oss-20b` wins on latency, which is what the deep dive measures, and did
not leak. `gpt-oss-120b` invented a city when none was given and wrote a
spurious fact on a question. The compound models reject `reasoning_format`, so
they could not be compared fairly. `qwen` was clean on everything it completed
and used better fact subjects, but rate limited at 6 of 10 turns, so there is
not enough evidence to prefer it.

Both gpt-oss models still call `get_weather` with a placeholder location rather
than asking, so the tool rejects a missing or placeholder location server side
instead of geocoding it.

## 4. Memory

Any fact the user states about themselves gets written through a memory tool
the model can call. On each turn the stored facts are injected into the system
prompt. Writes happen at the moment the model decides something is worth
keeping, not at end of session, so nothing is lost if the tab closes.

There are two levels of identity, which did not exist when this section was
first written:

- **Facts are owner scoped**, `sarjy:facts:<ownerId>`, keyed to the httpOnly
  cookie. They describe the person, so they outlive any single conversation and
  survive starting a new one. This is what makes "what is my favourite colour"
  work across sessions, which the brief requires.
- **Turns are session scoped**, `sarjy:turns:<sessionId>`. One cookie owner has
  many conversations; starting a new one clears the transcript, not the memory.

Facts were originally keyed by session id, which meant the New session button
silently wiped memory. Facts stranded under old session keys are left to expire
with their 30 day TTL rather than migrated.

## 5. External API

Weather (Open-Meteo). Weather is the single most common thing people ask a
voice assistant, so it makes Sarjy useful rather than a demo that only talks
about itself. It needs no API key, which keeps setup friction near zero. Most
importantly for the deep dive, it puts a real network round trip inside the
response path, which makes it a live test case for latency rather than a
synthetic one.

## 6. Deep dive: semantic caching for lower time to first audio

**Goal:** cut time to first audio by serving previously answered questions from
a cache, matched by meaning rather than exact string.

**How I'll measure:** timestamps at each stage boundary. STT end, LLM first
token, TTS first byte, playback start. Run each path 10 to 20 times and report
median and p95, not average, since tail latency is what a user actually feels.
Report cache hit and cache miss separately.

**What I'll try:** embed each incoming question, look for a stored question
above a similarity threshold, and on a hit return the stored answer and its
already synthesised audio. On a miss, run the normal path and write the result
back.

**The cache is scoped per session,** for the same reason everything else now
is. Answers are conditioned on that session's remembered facts, so a global
cache could serve one user's personal details to another on a paraphrase
match. Per session scoping lowers the hit rate and is the right trade.

**Next steps with more time:**
- Determine the minimum viable similarity threshold empirically. Too loose
  serves wrong answers from near misses, too tight makes the cache useless.
  Needs a labelled set of paraphrase pairs to tune against rather than a
  guessed constant.
- Per query type TTL. Weather goes stale within the hour, a stored favourite
  colour never does.
- Stream TTS sentence by sentence instead of waiting for the full response.
- Measure under real network conditions, not localhost.

## 6b. Results (built and measured)

Built: one Upstash Vector index with hosted `text-embedding-3-small`. Lookup
runs before `getFacts` in `respond()`; a hit returns stored text plus inlined
audio and skips the LLM and TTS. Write-back runs in the existing `after()`
block. Tool turns (weather) are not cached.

**Latency, server-side chat total, deployed, n=12 each:**

| | median | p95 |
|---|---|---|
| Cache hit | 283ms | 3350ms |
| Cache miss | 1489ms | 6208ms |

A hit also skips TTS (~600ms), so the end-to-end time-to-first-audio saving is
larger than the ~1200ms chat delta: roughly 1200ms of LLM plus 600ms of TTS.
The p95 figures are dominated by Vercel cold starts and network variance, which
is why median is the honest central number and why hit and miss are reported
separately, not blended.

The new `cache_lookup` mark (hosted embedding + vector query) costs ~300ms and
is paid on every turn including misses, so a miss is slightly slower than the
pre-cache baseline. That is the price of the hit path.

**Threshold experiment (20 hand-written pairs).** The finding was that the
distributions overlap and there is no clean separating threshold:

    threshold | true-hit | false-hit
      0.72    |  8/10    |  2/10
      0.80    |  4/10    |  2/10
      0.90    |  0/10    |  0/10

The worst case: "where do you live" (about the assistant) scored 0.871 against a
stored "Where do I live?" (about the user) — higher than every genuine
paraphrase. One pronoun flips the meaning but barely moves the embedding.

Chosen thresholds, from the data:

- **Canned 0.72.** Loose, because canned answers are generic (greetings,
  identity, capabilities) and a wrong hit is harmless. Verified: paraphrases
  like "who are you exactly" and "what are you able to help with" hit.
- **Learned 0.90.** Near-exact only. A looser learned threshold would serve one
  answer's personal facts for a differently-meant question, which the data
  shows is unavoidable at any threshold loose enough to catch paraphrases. So
  learned effectively catches only re-asks of the same question.

**Not built: filler audio.** The mechanism is designed (random non-committal
vocalisation on the miss path, gated so hits stay silent) but the audio assets
need TTS synthesis, and the TTS daily token cap was exhausted during testing.
Left as a next step rather than shipped as dead code.

## 7. Risks and open questions

- No auth means the deployed demo is open to spam and abuse. Cookie scoping
  stops one visitor reading another's transcripts and remembered facts, but a
  stolen or copied cookie is still full access to that browser's data.
- A similarity threshold that is too loose could serve a confidently wrong
  cached answer.
- Free tier rate limits on the LLM and TTS providers.
- Browser STT support varies across browsers.
- Cached weather answers go stale quickly, so weather may need to bypass the
  cache entirely.