import { requireOwnerId } from "@/lib/identity";
import { getFacts } from "@/lib/memory";
import {
  getCurrentSessionId,
  getTurns,
  selectSession,
  startSession,
} from "@/lib/sessions";

async function payload(ownerId: string, sessionId: string) {
  const [turns, facts] = await Promise.all([
    getTurns(sessionId),
    getFacts(ownerId),
  ]);
  return { sessionId, turns, facts };
}

// The caller's current conversation.
export async function GET() {
  try {
    const ownerId = await requireOwnerId();
    const sessionId = await getCurrentSessionId(ownerId);
    return Response.json(await payload(ownerId, sessionId));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 502 });
  }
}

// With a sessionId, switch to it (if owned). Without one, start a new session.
export async function POST(request: Request) {
  try {
    const ownerId = await requireOwnerId();
    const { sessionId } = await request.json().catch(() => ({}));

    if (sessionId) {
      if (!(await selectSession(ownerId, sessionId))) {
        return Response.json({ error: "Not found" }, { status: 404 });
      }
      return Response.json(await payload(ownerId, sessionId));
    }

    return Response.json(await payload(ownerId, await startSession(ownerId)));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 502 });
  }
}
