
**Key decisions:**

| Decision | Choice | Why | Alternative rejected |
|---|---|---|---|
| STT | Browser Web Speech API | Zero setup, brief says audio plumbing is not being evaluated | Whisper on Groq, more latency in the path |
| LLM | Groq | Fastest time to first token, which is what the deep dive is about | OpenAI, slower first token |
| TTS | Provider API (Groq PlayAI) | Returns real audio files, so responses can be cached and measured | Browser speechSynthesis, not measurable and not cacheable |
| Storage and cache | Upstash | Managed, no infra work, vector and KV in one place | Self hosted Redis or pgvector, too much setup for the time budget |

## 4. Memory

Any fact the user states about themselves gets written through a memory tool
the model can call. Facts are stored in Upstash keyed by session id. On each
turn the stored facts are injected into the system prompt. Writes happen at the
moment the model decides something is worth keeping, not at end of session, so
nothing is lost if the tab closes.

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

**Next steps with more time:**
- Determine the minimum viable similarity threshold empirically. Too loose
  serves wrong answers from near misses, too tight makes the cache useless.
  Needs a labelled set of paraphrase pairs to tune against rather than a
  guessed constant.
- Per query type TTL. Weather goes stale within the hour, a stored favourite
  colour never does.
- Stream TTS sentence by sentence instead of waiting for the full response.
- Measure under real network conditions, not localhost.

## 7. Risks and open questions

- No auth means the deployed demo is open to spam and abuse.
- A similarity threshold that is too loose could serve a confidently wrong
  cached answer.
- Free tier rate limits on the LLM and TTS providers.
- Browser STT support varies across browsers.
- Cached weather answers go stale quickly, so weather may need to bypass the
  cache entirely.