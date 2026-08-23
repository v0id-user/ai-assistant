import { NextResponse, type NextRequest } from "next/server";

import { COOKIE_NAME, COOKIE_OPTIONS } from "@/lib/identity";

// Hands every browser an id on its first request, so no handler has to trust
// an id supplied by the client.
export function proxy(request: NextRequest) {
  if (request.cookies.has(COOKIE_NAME)) return NextResponse.next();

  const id = crypto.randomUUID();
  // Setting it on the request too makes it visible to this same request.
  request.cookies.set(COOKIE_NAME, id);
  const response = NextResponse.next({ request });
  response.cookies.set(COOKIE_NAME, id, COOKIE_OPTIONS);
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
