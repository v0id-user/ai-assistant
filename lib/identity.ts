// Who is calling. A cookie identifies a browser; that browser owns sessions.
// Nothing about identity is ever read from the request body.

import { cookies } from "next/headers";

export const COOKIE_NAME = "sarjy_sid";

export const COOKIE_OPTIONS = {
  httpOnly: true,
  // http://localhost cannot receive a Secure cookie, so this is production only.
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: 60 * 60 * 24 * 30, // 30 days, matching the data TTLs
};

// The proxy sets this on the first request, so by the time any handler runs it
// is present. Handlers that can still race it create their own.
export async function getOwnerId(): Promise<string | null> {
  const store = await cookies();
  return store.get(COOKIE_NAME)?.value ?? null;
}

// Route Handlers may set cookies; Server Components may not.
export async function requireOwnerId(): Promise<string> {
  const store = await cookies();
  const existing = store.get(COOKIE_NAME)?.value;
  if (existing) return existing;

  const id = crypto.randomUUID();
  store.set(COOKIE_NAME, id, COOKIE_OPTIONS);
  return id;
}
