import { after } from "next/server";
import Groq from "groq-sdk";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "groq-sdk/resources/chat/completions";

import { getFacts, saveFact } from "@/lib/memory";
import { getWeather } from "@/lib/weather";
import { createTimer } from "@/lib/timing";
import { saveTrace, type ToolCall } from "@/lib/traces";
import { getCurrentSessionId, recordTurns } from "@/lib/sessions";
import { requireOwnerId } from "@/lib/identity";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const MODEL = process.env.GROQ_MODEL ?? "openai/gpt-oss-20b";

// The model can chain save_fact then get_weather, so allow a couple of rounds
// but keep a hard stop so a confused model cannot loop forever.
const MAX_TOOL_ROUNDS = 4;

const tools: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "save_fact",
      description:
        "Save a durable fact the USER explicitly stated about THEMSELVES in " +
        "their most recent message. Only use it for something the user said " +
        "in their own words. Never save an inference, a guess, a value that " +
        "came back from another tool, anything you said yourself in an " +
        "earlier reply, or anything the user merely asked about. If the user " +
        "did not state it about themselves just now, do not call this. " +
        "If one message contains several facts, call this once for each, " +
        "with a different subject each time. Never call it twice with the " +
        "same subject.",
      parameters: {
        type: "object",
        properties: {
          subject: {
            type: "string",
            description:
              "What the fact is about, as a short lowercase noun phrase, " +
              "e.g. 'name', 'favourite colour', 'city'. Reuse the same " +
              "subject when updating, so the new value replaces the old.",
          },
          fact: {
            type: "string",
            description:
              "The fact as a short predicate with no pronouns and no subject, " +
              "e.g. 'Lives in Riyadh' or 'Name is Fahad'. Never guess the " +
              "user's gender.",
          },
        },
        required: ["subject", "fact"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_weather",
      description:
        "Get the current weather for a place the user named. Only call this " +
        "when a location is available from the user's message or from a " +
        "saved fact about where they live. Never invent or default a " +
        "location; if you do not have one, ask the user instead.",
      parameters: {
        type: "object",
        properties: {
          location: {
            type: "string",
            description:
              "City or place name the user actually gave, e.g. 'Riyadh'. " +
              "Never a default or a guess.",
          },
        },
        required: ["location"],
      },
    },
  },
];

// After a tool call the model can return two output segments that the API
// joins with no separator, giving "Got it.Nice, Jeddah is beautiful." Prompt
// wording does not reliably prevent it, so repair the seam: a sentence end
// immediately followed by a capital is always a missing space.
function repairRunOn(text: string): string {
  return text.replace(/([.!?])([A-Z\u0600-\u06FF])/g, "$1 $2");
}

function systemPrompt(): string {
  const base =
    "You are Sarjy, a voice assistant. Your replies are read aloud, so keep " +
    "them short and conversational: exactly one short sentence, no markdown, " +
    "no lists, no emoji. Never append a second sentence offering further " +
    "help, such as asking whether there is anything else. Stop after the one " +
    "sentence that answers them. When the user states something durable about " +
    "themselves, call save_fact. When asked about weather, call get_weather; " +
    "if no location was given, ask which city rather than guessing. " +
    "Only call a tool when the user's most recent message actually needs it. " +
    "Questions about the user themselves, such as where they live or what " +
    "their name is, are answered from what you already know above, with no " +
    "tool call. get_weather is only for current weather conditions. " +
    "Earlier turns in this conversation are already answered: never repeat a " +
    "tool call just because it appears above. If the latest message can be " +
    "answered directly, answer it and call nothing. " +
    "After using tools, always reply to the user in words. " +
    "Always reply in English; the voice can only speak English.";

  return base;
}

// Facts live in their own message rather than in the system prompt. Groq
// caches prompt prefixes on exact match, so anything that changes per user or
// per turn has to sit after the static part: system prompt and tool
// definitions stay byte-identical across requests and keep hitting the cache.
function factsMessage(facts: string[]): ChatCompletionMessageParam[] {
  if (facts.length === 0) return [];
  return [
    {
      role: "system",
      content: `What you already know about this user:\n${facts
        .map((f) => `- ${f}`)
        .join("\n")}`,
    },
  ];
}

async function runTool(
  name: string,
  args: Record<string, unknown>,
  ownerId: string,
): Promise<string> {
  if (name === "save_fact") {
    // Facts belong to the person, not the conversation.
    await saveFact(ownerId, String(args.subject), String(args.fact));
    return JSON.stringify({ saved: true });
  }
  if (name === "get_weather") {
    const location = String(args.location ?? "").trim();
    // Models sometimes call this with a placeholder rather than asking. Refuse
    // instead of geocoding nonsense, and tell the model what to do about it.
    if (location.length < 2 || /^(\?+|unknown|n\/?a|none|null|city)$/i.test(location)) {
      return JSON.stringify({
        error: "No location given. Ask the user which city, do not guess.",
      });
    }
    return JSON.stringify(await getWeather(location));
  }
  return JSON.stringify({ error: `Unknown tool ${name}` });
}

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
  const facts = await getFacts(ownerId);
  timer.mark("memory_load");

  // History is the conversation, not the tool transcript. Replaying tool
  // calls, tool results and the model's own `reasoning` makes it continue an
  // old train of thought: it re-fires stale tools and runs several replies
  // together. Keep only what was actually said.
  const priorTurns: ChatCompletionMessageParam[] = (
    history as { role?: string; content?: unknown }[]
  )
    .filter(
      (m) =>
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim().length > 0,
    )
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content as string,
    }));

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt() },
    ...factsMessage(facts),
    ...priorTurns,
    { role: "user", content: transcript },
  ];

  let text = "";
  const toolLog: ToolCall[] = [];
  const tokens = { prompt: 0, completion: 0, cached: 0 };

  const account = (usage: unknown) => {
    const u = usage as {
      prompt_tokens?: number;
      completion_tokens?: number;
      prompt_tokens_details?: { cached_tokens?: number };
    } | null;
    if (!u) return;
    tokens.prompt += u.prompt_tokens ?? 0;
    tokens.completion += u.completion_tokens ?? 0;
    tokens.cached += u.prompt_tokens_details?.cached_tokens ?? 0;
  };

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const completion = await groq.chat.completions.create({
      model: MODEL,
      messages,
      tools,
      // 'hidden' keeps the separate reasoning field out of the reply. It
      // cannot stop the model writing scratchpad text as the answer itself,
      // so also damp the sampling and cap the length: a spoken reply is one
      // sentence, and rambling is what the meta-commentary rides in on.
      reasoning_format: "hidden",
      temperature: 0.3,
      // Do not cap this to save the wasted draft: the same call also has to
      // emit tool calls, and once tool results are in the context the hidden
      // reasoning grows. Capping it truncates mid tool call, which surfaces
      // as "Failed to parse tool call arguments" or, when the exchange is
      // left unfinished, "Tool choice is none, but model called a tool".
      // Measured: 50 truncates before any call appears, 200 breaks the
      // multi-fact and post-tool rounds.
      max_completion_tokens: 800,
    });
    account(completion.usage);

    const message = completion.choices[0].message;
    const toolCalls = message.tool_calls ?? [];

    // Name the mark after what the model actually did, so a trace reads as a
    // sequence of events rather than anonymous round numbers.
    timer.mark(
      toolCalls.length
        ? `llm_asks_for_${toolCalls.map((c) => c.function.name).join("+")}`
        : "llm_answers",
    );

    // Always kept in the context. Dropping it on plain turns was tried and
    // reverted: the schema call writes worse replies without the draft, and
    // after tool results an unfinished exchange makes it attempt another
    // tool call, which the schema call rejects.
    messages.push(message as ChatCompletionMessageParam);

    if (toolCalls.length === 0) {
      text = message.content ?? "";
      break;
    }

    for (const call of toolCalls) {
      let result: string;
      try {
        result = await runTool(
          call.function.name,
          JSON.parse(call.function.arguments || "{}"),
          ownerId,
        );
      } catch (err) {
        result = JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        });
      }
      toolLog.push({
        round,
        name: call.function.name,
        args: call.function.arguments || "{}",
        result: result.slice(0, 200),
      });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: result,
      });
    }
    timer.mark(`run_${toolCalls.map((c) => c.function.name).join("+")}`);
  }

  // The spoken reply always comes from its own call with tools switched off
  // and a JSON schema enforcing a single `reply` field. Structured output
  // cannot be combined with tool calling, which is why it is a separate call;
  // the payoff is that the model has no place to put turn-taking narration,
  // so it cannot reach the user. This also covers the case where the tool
  // loop ended with no content at all.
  const spoken = await groq.chat.completions.create({
    model: MODEL,
    messages: [
      ...messages,
      {
        role: "system",
        content:
          "Reply to the user's last message in one short spoken sentence, " +
          "using the tool results above. Output only the reply itself.",
      },
    ],
    reasoning_format: "hidden",
    temperature: 0.3,
    // Hidden reasoning still consumes completion tokens, so this budget has
    // to cover the model's thinking as well as the JSON. Too low and the
    // generation is cut off mid-object and fails schema validation.
    max_completion_tokens: 800,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "spoken_reply",
        strict: true,
        schema: {
          type: "object",
          properties: { reply: { type: "string" } },
          required: ["reply"],
          additionalProperties: false,
        },
      },
    },
  });
  account(spoken.usage);
  timer.mark("llm_writes_reply");

  try {
    text = JSON.parse(spoken.choices[0].message.content ?? "{}").reply ?? text;
  } catch {
    // Schema-constrained output should always parse; keep the loop's text if not.
  }

  text = repairRunOn(text.trim());

  const timings = timer.done();

  // after() runs once the response has been flushed to the client, so the
  // trace write costs the turn nothing.
  after(async () => {
    const now = Date.now();
    try {
      await Promise.all([
        saveTrace({
          at: new Date(now).toISOString(),
          sessionId,
          transcript,
          response: text,
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
