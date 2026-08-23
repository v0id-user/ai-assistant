import { listSessions } from "@/lib/sessions";

export async function GET() {
  try {
    return Response.json({ sessions: await listSessions() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 502 });
  }
}
