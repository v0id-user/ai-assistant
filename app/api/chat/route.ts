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

const MODEL = process.env.GROQ_MODEL ?? "openai/gpt-oss-120b";

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
        "did not state it about themselves just now, do not call this. Call " +
        "once per distinct subject.",
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

function systemPrompt(facts: string[]): string {
  const base =
    "You are Sarjy, a voice assistant. Your replies are read aloud, so keep " +
    "them short and conversational: one or two sentences, no markdown, no " +
    "lists, no emoji. When the user states something durable about " +
    "themselves, call save_fact. When asked about weather, call get_weather; " +
    "if no location was given, ask which city rather than guessing. " +
    "After using tools, always reply to the user in words. " +
    "Always reply in the same language the user spoke in.";

  if (facts.length === 0) return base;
  return `${base}\n\nWhat you already know about this user:\n${facts
    .map((f) => `- ${f}`)
    .join("\n")}`;
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
    return JSON.stringify(await getWeather(String(args.location)));
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

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt(facts) },
    ...(history as ChatCompletionMessageParam[]),
    { role: "user", content: transcript },
  ];

  let text = "";
  const toolLog: ToolCall[] = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const completion = await groq.chat.completions.create({
      model: MODEL,
      messages,
      tools,
    });
    timer.mark(`llm_round_${round}`);

    const message = completion.choices[0].message;
    messages.push(message as ChatCompletionMessageParam);

    const toolCalls = message.tool_calls ?? [];
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
    timer.mark(`tools_round_${round}`);
  }

  // The model can end a round with neither tool calls nor content, and it can
  // run out of tool rounds. Either way the user would hear silence, so make one
  // last call with tools off to force a spoken reply.
  if (!text.trim()) {
    const final = await groq.chat.completions.create({
      model: MODEL,
      messages,
      tool_choice: "none",
    });
    text = final.choices[0].message.content?.trim() ?? "";
    timer.mark("llm_final");
  }

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
