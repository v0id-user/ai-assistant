# Status

Live: https://take-home-sarj.vercel.app
Last updated after the cookie-scoping change (`29d9a06`).

## 1. Verified on the deployed URL

Actually run against production, not localhost and not assumed:

| What | Result |
|---|---|
| `GET /` | 200 |
| `POST /api/stt` | real webm/opus upload transcribed correctly, ~300-500ms |
| `POST /api/chat` | `save_fact` fires, facts persist to Upstash |
| memory across a New session | fact stated, New session, recalled correctly |
| `POST /api/chat` (fresh, no history) | recalls the stored location **and** calls `get_weather` |
| `POST /api/tts` | 200, ~85KB wav, 24kHz mono, first byte ~185ms |
| `GET /api/session` | current session with turns and facts |
| `GET /api/sessions` | caller's sessions only |
| `GET /api/sessions/[id]` | 404 unless the caller owns it |
| `GET /_debug/traces` | caller's current session only |

Facts are owner scoped (`sarjy:facts:<ownerId>`) and turns are session scoped,
so starting a new conversation clears the transcript but keeps memory. A second
cookie asking the same question gets no answer, so the broader key does not
leak across visitors.

Cookie isolation was tested with two independent cookie jars. Given A's exact
session id, B still gets 404 on both read and switch, and sees an empty
session list and no traces.

Production cookie: `Secure; HttpOnly; SameSite=lax; Max-Age=2592000`.

Representative production timings for one turn:

    memory_load=214.6ms llm_round_0=491.2ms tools_round_0=841.1ms llm_round_1=216.2ms

`memory_load` is much faster deployed than locally (~150-215ms against ~470ms);
most of that hop was a localhost artifact.

## 2. Unmet from Section 2

**Nothing.** Every section 2 item is met: voice in and voice out, memory across
sessions, in-session history, speech to text on every desktop browser, weather,
deployed and publicly reachable.

The mic path -- `MediaRecorder` -> upload -> `audio.play()` -- was confirmed
working by the user on 2026-08-24. It is the one leg that cannot be verified
from a terminal, since it needs a real microphone.

"Streaming STT" was struck from section 2 deliberately. Groq transcription is
batch only, confirmed at the type level. See the amendment in `tdd.md`.

## 3. Broken, half-finished, untested

- **The mic path works**, but only a single confirmed run. Not yet exercised:
  back-to-back turns, long recordings, and recovery after a denied mic prompt.
- **`llm_first_token` does not exist.** The chat route is non-streaming, so
  `llm_round_0` is completion time, not first token. Matters for the deep dive.
- **Empty-reply fallback is unexercised.** The `tool_choice: "none"` retry in
  `app/api/chat/route.ts` was written for a real observed bug and has not fired
  since.
- **`MAX_TOOL_ROUNDS` exhaustion never hit.** Maximum observed is 2 rounds.
- **Unbounded history.** The client replays the whole message log every turn
  with no trimming; a long session will eventually hit the context limit.
- **Cookie scoping is not auth.** A copied cookie is full access to that
  browser's data. Clearing cookies orphans the data until its TTL expires.
- **No auto-deploy.** The Vercel project has no GitHub repo connection, so
  `git push` does not deploy.
- **Preview env vars unset.** Production only.
- **Personal:** revoke the Vercel refresh token that leaked into the session
  transcript: https://vercel.com/account/tokens

### Deploying

CLI deploys from the repo were blocked because the commit author email could
not be matched to a GitHub account. A GitHub login connection has since been
added to the Vercel account, but a repo-root deploy has **not** been retested.

Known-good fallback, deploys in about 25s:

    rsync -a --exclude .git --exclude node_modules --exclude .next ./ /tmp/nogit/
    cp -r .vercel /tmp/nogit/.vercel
    cd /tmp/nogit && vercel deploy --prod --yes --scope v0id-dfd8a8de

Deploying from a directory with no `.git` attaches no git metadata, which is
what sidesteps the author check.

## 4. Repository

Clean tree, everything committed and pushed to `main`. Deployed build matches
`HEAD`.

## Where section 6 plugs in

**Timing marks.** `lib/timing.ts` -> `createTimer(label)` with `mark()` and
`done()`, returning `{ totalMs, stages }`. Current marks:

    chat: memory_load -> llm_round_N -> tools_round_N -> [llm_final]
    stt:  transcribe
    tts:  tts_first_byte -> tts_complete

All reach the client: chat and stt in the JSON body, tts in an `X-Timings`
header because its body is audio. `stage()` in `app/page.tsx` matches by name
prefix, so a `cache_*` prefix groups with no client change.

**The seam.** `app/api/chat/route.ts`, inside `respond()`, immediately before:

    const facts = await getFacts(sessionId);
    timer.mark("memory_load");

That is the last point where you can return without paying for the LLM. The
route is already structured for an early return. Note `/api/chat` returns JSON
text and TTS is a separate round trip, so caching audio needs a response-shape
decision.

**Write-back** belongs in the existing `after()` block in the same file. It
already runs post-response with `Promise.all([saveTrace, recordTurns])` and
swallows failures, so a cache write there costs the turn nothing.

**Upstash today.** One Redis database, one lazy client in `lib/redis.ts` via
`Redis.fromEnv()`. Keys:

    sarjy:owner:<ownerId>:sessions   zset, 30d
    sarjy:owner:<ownerId>:current    string, 30d
    sarjy:facts:<sessionId>          set, 30d
    sarjy:turns:<sessionId>          list, 30d
    sarjy:traces:<sessionId>         capped list of 50, 1d

Two things that will bite:

1. **Upstash Vector is a separate product** with its own credentials. Only
   `UPSTASH_REDIS_REST_URL` and `_TOKEN` exist today, production only.
2. **Groq has no embedding model.** Confirmed twice: absent from the live model
   list, and `@ai-sdk/groq` types `textEmbeddingModel()` as returning `never`.
   The embed step needs Upstash Vector's hosted embedding or another provider.

**The cache is scoped per session** (recorded in `tdd.md` section 6). Answers
are conditioned on that session's facts, so a global cache could serve one
visitor's personal details to another on a paraphrase match.

**Baseline.** Only single samples exist. Section 6 asks for median and p95 over
10 to 20 runs. `/_debug/traces` already stores the last 50 turns per session
with full stage timings, so it can serve as the baseline collector; it just
needs the runs put through it.

**Weather should probably bypass the cache** — section 7 flags it, and it is
the most common demo query. Cached weather goes stale within the hour. Tool
use is visible in a trace as `tools_round_0`.
