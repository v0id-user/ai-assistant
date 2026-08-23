import { requireOwnerId } from "@/lib/identity";
import { listSessions } from "@/lib/sessions";

export async function GET() {
  try {
    const ownerId = await requireOwnerId();
    return Response.json({ sessions: await listSessions(ownerId) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 502 });
  }
}
