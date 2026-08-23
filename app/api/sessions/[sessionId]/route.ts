import { getFacts } from "@/lib/memory";
import { getTurns } from "@/lib/sessions";

export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/sessions/[sessionId]">,
) {
  const { sessionId } = await ctx.params;
  try {
    const [turns, facts] = await Promise.all([
      getTurns(sessionId),
      getFacts(sessionId),
    ]);
    return Response.json({ turns, facts });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 502 });
  }
}
