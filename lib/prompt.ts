import type { ChatCompletionMessageParam } from "groq-sdk/resources/chat/completions";

// After a tool call the model can return two output segments that the API
// joins with no separator, giving "Got it.Nice, Jeddah is beautiful." Prompt
// wording does not reliably prevent it, so repair the seam: a sentence end
// immediately followed by a capital is always a missing space.
export function repairRunOn(text: string): string {
  return text.replace(/([.!?])([A-Z\u0600-\u06FF])/g, "$1 $2");
}

export function systemPrompt(): string {
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

export function buildMessages(
  facts: string[],
  history: unknown[],
  transcript: string,
): ChatCompletionMessageParam[] {
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

  return [
    { role: "system", content: systemPrompt() },
    ...factsMessage(facts),
    ...priorTurns,
    { role: "user", content: transcript },
  ];
}
