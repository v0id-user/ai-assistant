import Groq from "groq-sdk";
import type { ChatCompletionMessageParam } from "groq-sdk/resources/chat/completions";

import { createTimer } from "@/lib/timing";
import { type ToolCall } from "@/lib/traces";
import { tools, runTool } from "@/lib/tools";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const MODEL = process.env.GROQ_MODEL ?? "openai/gpt-oss-20b";

// The model can chain save_fact then get_weather, so allow a couple of rounds
// but keep a hard stop so a confused model cannot loop forever.
const MAX_TOOL_ROUNDS = 4;

type Timer = ReturnType<typeof createTimer>;

export function createTokenAccount() {
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

  return { tokens, account };
}

// Runs the tool loop over `messages`, mutating it in place (the same array the
// caller keeps for the spoken-reply call and the history response). Returns the
// draft text and the log of tool calls made.
export async function runToolLoop(
  messages: ChatCompletionMessageParam[],
  ownerId: string,
  timer: Timer,
  account: (usage: unknown) => void,
): Promise<{ text: string; toolLog: ToolCall[] }> {
  let text = "";
  const toolLog: ToolCall[] = [];

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

  return { text, toolLog };
}

// The spoken reply always comes from its own call with tools switched off
// and a JSON schema enforcing a single `reply` field. Structured output
// cannot be combined with tool calling, which is why it is a separate call;
// the payoff is that the model has no place to put turn-taking narration,
// so it cannot reach the user. This also covers the case where the tool
// loop ended with no content at all.
export async function writeSpokenReply(
  messages: ChatCompletionMessageParam[],
  timer: Timer,
  account: (usage: unknown) => void,
  fallbackText: string,
): Promise<string> {
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
    return JSON.parse(spoken.choices[0].message.content ?? "{}").reply ?? fallbackText;
  } catch {
    // Schema-constrained output should always parse; keep the loop's text if not.
    return fallbackText;
  }
}
