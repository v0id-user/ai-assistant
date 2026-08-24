import type { ChatCompletionTool } from "groq-sdk/resources/chat/completions";

import { saveFact } from "@/lib/memory";
import { getWeather } from "@/lib/weather";

export const tools: ChatCompletionTool[] = [
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

export async function runTool(
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
