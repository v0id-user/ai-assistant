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
  not auth and does not survive clearing cookies; it exists because the app is
  deployed at a public URL and the original single-user assumption did not hold.
- No mobile specific UI. Desktop browser only, keeps the surface small.
- No error recovery beyond basic failure states. Out of scope.
- No self hosted vector store. Using Upstash so the storage question does not
  become the whole project.
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
| LLM | Groq | Fastest time to first token, which is what this project optimises for | OpenAI, slower first token |
| LLM model | `openai/gpt-oss-20b` | Measured against every chat model Groq offers | `gpt-oss-120b`, slower and leaked reasoning |
| TTS | Provider API (Groq PlayAI) | Returns real audio files, so responses can be cached and measured | Browser speechSynthesis, not measurable and not cacheable |
| Storage and cache | Upstash | Managed, no infra work, vector and KV in one place | Self hosted Redis or pgvector, too much setup for the time budget |

### Amendment: STT moved off the Web Speech API

Originally this was the browser Web Speech API, chosen for zero setup. It is
not supported across browsers: Brave ships `webkitSpeechRecognition` but
disables the backend, so it throws `network` at runtime. The constructor still
exists, so it cannot be feature detected and the unsupported-browser banner
never fires. Section 7 already listed this risk.

Trade-offs:

- **Streaming STT is dropped from scope.** Groq transcription is batch only,
  verified at the type level: `@ai-sdk/groq` exposes `TranscriptionModelV4` and
  the AI SDK's `streamTranscribe` has no Groq implementation. There is no live
  partial transcript.
- **Roughly 400ms of serial latency is added** to every turn. Web Speech
  transcribed while the user spoke; Whisper runs after they stop. Worth it for
  an app that works in more than one browser.

`whisper-large-v3` over `-turbo`: at 2 to 6 second utterances the two were
indistinguishable on latency when measured, so the lower word error rate that
Groq publishes (10.3% against 12%) decides it.

### Model comparison

The LLM was originally picked on one smoke test, which was not good enough.
Ten fixed prompts covering all four behaviours were then run against every
chat capable model Groq offers, with identical settings.

| Model | Turns | Latency median / p95 | Tool correctness | Reasoning leak | Format |
|---|---|---|---|---|---|
| `openai/gpt-oss-20b` | 10/10 | 528ms / 1336ms | 9/10 | 0/10 | 9/10 |
| `openai/gpt-oss-120b` | 10/10 | 750ms / 2112ms | 8/10 | 1/10 | 9/10 |
| `qwen/qwen3.6-27b` | 6/10 | 725ms / 1493ms | 6/6 | 0/6 | 6/6 |
| `groq/compound`, `-mini` | 0/10 | n/a | n/a | n/a | n/a |

`gpt-oss-20b` was chosen. What the table does not show: `gpt-oss-120b`'s one
tool error was inventing a city when none was given, `qwen` rate limited before
it could be judged, and the compound models reject `reasoning_format` so they
could not be compared on equal settings.

Both gpt-oss models call `get_weather` with a placeholder location rather than
asking, so the tool rejects a missing or placeholder location server side.

## 4. Memory

Any fact the user states about themselves gets written through a memory tool
the model can call. On each turn the stored facts are sent as their own system
message, placed after the static system prompt and tool definitions rather than
inside them, so the static prefix stays byte-identical from request to request
and keeps hitting Groq's prompt cache. Writes happen at the moment the model
decides something is worth keeping, not at end of session, so nothing is lost
if the tab closes.

There are two levels of identity, which did not exist when this section was
first written:

- **Facts are owner scoped**, `sarjy:facts:<ownerId>`, keyed to the httpOnly
  cookie. They describe the person, so they outlive any single conversation and
  survive starting a new one. This is what makes "what is my favourite colour"
  work across sessions, which is the point of the project.
- **Turns are session scoped**, `sarjy:turns:<sessionId>`. One cookie owner has
  many conversations; starting a new one clears the transcript, not the memory.

Facts were originally keyed by session id, which meant the New session button
silently wiped memory. Facts stranded under old session keys are left to expire
with their 30 day TTL rather than migrated.

## 5. External API

Weather (Open-Meteo). Weather is the single most common thing people ask a
voice assistant, so it makes Sarjy useful rather than a demo that only talks
about itself. It needs no API key, which keeps setup friction near zero. Most
importantly for the latency work, it puts a real network round trip inside the
response path, which makes it a live test case for latency rather than a
synthetic one.

## 6. Semantic caching for lower time to first audio

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

A hit also skips TTS (~600ms), so the saving is roughly 1200ms of LLM plus
600ms of TTS.

The p95 figures are far above the medians. That spread was not isolated to a
cause, so treat the medians as the reliable numbers.

The new `cache_lookup` mark (hosted embedding + vector query) costs ~300ms and
is paid on every turn including misses, so a miss is slightly slower than the
pre-cache baseline. That is the price of the hit path.

Next step: run the lookup and the normal path in parallel and race them. A miss
would cost nothing, because the normal path was already running, and a hit
returns the whole answer immediately. That removes the lookup cost from the
miss path entirely. Not built.

**Threshold experiment (20 hand-written pairs).** The finding was that the
distributions overlap and there is no clean separating threshold:

    threshold | true-hit | false-hit
      0.72    |  8/10    |  2/10
      0.80    |  4/10    |  2/10
      0.90    |  0/10    |  0/10

The worst case: "where do you live" (about the assistant) scored 0.871 against a
stored "Where do I live?" (about the user), higher than every genuine
paraphrase. One pronoun flips the meaning but barely moves the embedding.

Chosen thresholds, from the data:

- **Canned 0.72.** Loose, because canned answers are generic (greetings,
  identity, capabilities) and a wrong hit is harmless. Verified: paraphrases
  like "who are you exactly" and "what are you able to help with" hit.
- **Learned 0.90.** Near-exact only. A looser learned threshold would serve one
  answer's personal facts for a differently-meant question, which the data
  shows is unavoidable at any threshold loose enough to catch paraphrases. So
  learned effectively catches only re-asks of the same question.

**Confirmed in live use.** A 13 turn session gave 6 hits and 7 misses (46%),
hits at 280 to 460ms against misses at 1000 to 1830ms. The predicted false
positive appeared: "Where do you live?" matched the learned entry for "Where do
I live?". The pronoun flip is not separable at any threshold that still catches
genuine paraphrases, which is the honest limit of this approach.

**Not built: filler audio.** The mechanism is designed (random non-committal
vocalisation on the miss path, gated so hits stay silent) but the audio assets
need TTS synthesis, and the TTS daily token cap was exhausted during testing.
Left as a next step rather than shipped as dead code.

## 7. Risks and open questions

- No auth. Cookie scoping stops one visitor reading another's transcripts and
  remembered facts, but a copied cookie is full access to that browser's data,
  and the URL is public so the LLM and TTS quotas are open to abuse.
- The similarity threshold problem is now measured, not hypothetical. Genuine
  paraphrases and near misses overlap, and a pronoun flip ("where do you live"
  against a stored "where do I live") scores higher than real paraphrases. It
  happened in live use. Learned entries are held at 0.90 to contain it, which
  costs most of the paraphrase hit rate. Separating intent needs something
  other than cosine distance.
- Learned entries are per owner, so a fresh session has a zero hit rate until
  the cache warms. Only the canned entries hit immediately.
- Free tier limits are a real constraint, not a theoretical one. The TTS daily
  cap (3600 tokens) was exhausted during testing, which is why canned audio is
  incomplete and the filler audio was never built. LLM calls rate limited
  during the model comparison and cut one model's run short.
- Cached audio is stored as base64 in Redis, which grows with every distinct
  reply and shares the same store as sessions and facts. No eviction beyond the
  TTL.
- `ownerId` is interpolated into the vector query filter without escaping. It is
  a server-minted UUID from an httpOnly cookie today, so it is not reachable by
  a user, but the isolation depends on that id format rather than on escaping.
- Two LLM calls per turn. The spoken reply is generated separately under a JSON
  schema, which is what stops the model narrating its own turn-taking, but it
  adds a round trip on the miss path.
