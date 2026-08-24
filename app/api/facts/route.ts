import { cookies } from "next/headers";

import { COOKIE_NAME } from "@/lib/identity";

// Forget me: drop the cookie rather than deleting anything. The proxy mints a
// fresh id on the next request, so the caller starts clean with no facts, no
// conversations and no cache entries. The old data is simply unreachable and
// expires on its own TTL.
export async function DELETE() {
  (await cookies()).delete(COOKIE_NAME);
  return Response.json({ cleared: true });
}
