import { requireOwnerId } from "@/lib/identity";
import { getFacts } from "@/lib/memory";
import { getTurns, ownsSession } from "@/lib/sessions";

export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/sessions/[sessionId]">,
) {
  const { sessionId } = await ctx.params;
  try {
    const ownerId = await requireOwnerId();
    // A session id is not a capability; the caller must own it.
    if (!(await ownsSession(ownerId, sessionId))) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    const [turns, facts] = await Promise.all([
      getTurns(sessionId),
      getFacts(ownerId),
    ]);
    return Response.json({ turns, facts });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 502 });
  }
}
