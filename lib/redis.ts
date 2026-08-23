import { Redis } from "@upstash/redis";

// Built on first use, not at module load, so a build without credentials
// present neither warns nor fails.
let client: Redis | null = null;

export function redis(): Redis {
  if (!client) client = Redis.fromEnv();
  return client;
}
