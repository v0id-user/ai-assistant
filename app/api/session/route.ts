import { requireOwnerId } from "@/lib/identity";
import { getFacts } from "@/lib/memory";
import {
  getCurrentSessionId,
  getTurns,
  selectSession,
  startSession,
} from "@/lib/sessions";

async function payload(sessionId: string) {
  const [turns, facts] = await Promise.all([
    getTurns(sessionId),
    getFacts(sessionId),
  ]);
  return { sessionId, turns, facts };
}

// The caller's current conversation.
export async function GET() {
  try {
    const ownerId = await requireOwnerId();
    return Response.json(await payload(await getCurrentSessionId(ownerId)));
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
      return Response.json(await payload(sessionId));
    }

    return Response.json(await payload(await startSession(ownerId)));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 502 });
  }
}
