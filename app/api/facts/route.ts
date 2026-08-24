import { requireOwnerId } from "@/lib/identity";
import { clearFacts } from "@/lib/memory";

// Forget everything remembered about the caller. Scoped to their cookie, so
// one visitor can never clear another's facts.
export async function DELETE() {
  try {
    const ownerId = await requireOwnerId();
    await clearFacts(ownerId);
    return Response.json({ cleared: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 502 });
  }
}
