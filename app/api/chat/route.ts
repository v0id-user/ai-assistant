import Groq from "groq-sdk";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "groq-sdk/resources/chat/completions";

import { getFacts, saveFact } from "@/lib/memory";
import { getWeather } from "@/lib/weather";
import { createTimer } from "@/lib/timing";

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
        "Save a durable fact the user stated about themselves, so it can be recalled in later sessions. Use for preferences, names, locations, and similar. Do not use for passing remarks or questions.",
      parameters: {
        type: "object",
        properties: {
          fact: {
            type: "string",
            description:
              "The fact, written as a short third-person sentence, e.g. 'Lives in Riyadh'.",
          },
        },
        required: ["fact"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get the current weather for a named place.",
      parameters: {
        type: "object",
        properties: {
          location: {
            type: "string",
            description: "City or place name, e.g. 'Riyadh' or 'Paris, France'.",
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
    "themselves, call save_fact. When asked about weather, call get_weather.";

  if (facts.length === 0) return base;
  return `${base}\n\nWhat you already know about this user:\n${facts
    .map((f) => `- ${f}`)
    .join("\n")}`;
}

async function runTool(
  name: string,
  args: Record<string, unknown>,
  sessionId: string,
): Promise<string> {
  if (name === "save_fact") {
    await saveFact(sessionId, String(args.fact));
    return JSON.stringify({ saved: true });
  }
  if (name === "get_weather") {
    return JSON.stringify(await getWeather(String(args.location)));
  }
  return JSON.stringify({ error: `Unknown tool ${name}` });
}

export async function POST(request: Request) {
  const timer = createTimer("chat");

  const { transcript, sessionId, history = [] } = await request.json();

  if (!transcript || !sessionId) {
    return Response.json(
      { error: "transcript and sessionId are required" },
      { status: 400 },
    );
  }

  const facts = await getFacts(sessionId);
  timer.mark("memory_load");

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt(facts) },
    ...(history as ChatCompletionMessageParam[]),
    { role: "user", content: transcript },
  ];

  let text = "";

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
          sessionId,
        );
      } catch (err) {
        result = JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        });
      }
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: result,
      });
    }
    timer.mark(`tools_round_${round}`);
  }

  const timings = timer.done();

  return Response.json({
    text,
    // The client replays these on the next turn to keep conversation history.
    messages: messages.slice(1),
    timings,
  });
}
