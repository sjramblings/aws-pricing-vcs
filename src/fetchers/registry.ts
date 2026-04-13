import type { Fetcher } from "./types.ts";
import { bedrockFetcher } from "./bedrock.ts";

export const fetchers: Record<string, Fetcher> = {
  [bedrockFetcher.name]: bedrockFetcher,
};

export function getFetcher(name: string): Fetcher {
  const f = fetchers[name];
  if (!f) {
    throw new Error(
      `Unknown service '${name}'. Registered: ${Object.keys(fetchers).join(", ") || "(none)"}`,
    );
  }
  return f;
}

export function listFetchers(): Fetcher[] {
  return Object.values(fetchers);
}
