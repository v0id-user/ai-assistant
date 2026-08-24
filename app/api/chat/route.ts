import { after } from "next/server";

import { getFacts } from "@/lib/memory";
import { createTimer } from "@/lib/timing";
import { saveTrace } from "@/lib/traces";
import { lookup, learn } from "@/lib/cache";
import { getAudio } from "@/lib/audio";
import { getCurrentSessionId, recordTurns } from "@/lib/sessions";
import { requireOwnerId } from "@/lib/identity";
import { buildMessages, repairRunOn } from "@/lib/prompt";
import {
  createTokenAccount,
  runToolLoop,
  writeSpokenReply,
} from "@/lib/llm";

export async function POST(request: Request) {
  const timer = createTimer("chat");

  const { transcript, history = [] } = await request.json();

  if (!transcript) {
    return Response.json({ error: "transcript is required" }, { status: 400 });
  }

  // Identity comes from the cookie, never from the body.
  const ownerId = await requireOwnerId();
  const sessionId = await getCurrentSessionId(ownerId);

  try {
    return await respond(transcript, ownerId, sessionId, history, timer);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[chat] failed:", message);
    return Response.json({ error: message }, { status: 502 });
  }
}

async function respond(
  transcript: string,
  ownerId: string,
  sessionId: string,
  history: unknown[],
  timer: ReturnType<typeof createTimer>,
) {
  // Cache lookup first: this is the last point where the request can return
  // without paying for the LLM. A hit skips the LLM and TTS entirely.
  const hit = await lookup(transcript, ownerId);
  timer.mark("cache_lookup");

  if (hit) {
    // Inline the stored audio so the client plays it with no TTS round trip.
    const audio = await getAudio(hit.audioRef);
    const timings = timer.done();
    after(() => {
      void saveTrace({
        at: new Date().toISOString(),
        sessionId,
        transcript,
        response: hit.text,
        cached: true,
        cacheKind: hit.kind,
        timings,
      }).catch(() => {});
      void recordTurns(
        ownerId,
        sessionId,
        [
          { role: "user", text: transcript },
          { role: "assistant", text: hit.text },
        ],
        Date.now(),
      ).catch(() => {});
    });
    return Response.json({
      text: hit.text,
      cached: true,
      cacheKind: hit.kind,
      audio, // base64 wav, or null if not stored yet
      messages: [],
      timings,
    });
  }

  const facts = await getFacts(ownerId);
  timer.mark("memory_load");

  const messages = buildMessages(facts, history, transcript);

  const { tokens, account } = createTokenAccount();
  const { text: draft, toolLog } = await runToolLoop(
    messages,
    ownerId,
    timer,
    account,
  );

  let text = await writeSpokenReply(messages, timer, account, draft);
  text = repairRunOn(text.trim());

  const timings = timer.done();

  // after() runs once the response has been flushed to the client, so the
  // trace write costs the turn nothing.
  after(async () => {
    const now = Date.now();
    try {
      // Only cache tool-free turns. Tool answers (weather) go stale.
      const cacheable = toolLog.length === 0 && text.trim().length > 0;
      await Promise.all([
        cacheable
          ? learn(transcript, text, ownerId)
          : Promise.resolve(),
        saveTrace({
          at: new Date(now).toISOString(),
          sessionId,
          transcript,
          response: text,
          cached: false,
          tools: toolLog,
          tokens,
          request: messages
            .filter((m) => typeof m.content === "string")
            .map((m) => ({
              role: m.role,
              content: String(m.content).slice(0, 400),
            })),
          timings,
        }),
        recordTurns(
          ownerId,
          sessionId,
          [
            { role: "user", text: transcript },
            { role: "assistant", text },
          ],
          now,
        ),
      ]);
    } catch (err) {
      // Bookkeeping must never take the turn down with it.
      console.error("[after] write failed:", err);
    }
  });

  return Response.json({
    text,
    // The client replays these on the next turn to keep conversation history.
    messages: messages.slice(1),
    timings,
  });
}
