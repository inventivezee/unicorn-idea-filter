// Per-request/-run provider key set. A resolved ProviderKeys carries only
// the keys a user actually supplied; the accessor helpers fall back to the
// deployment env keys when a user key is absent — the "optional override"
// model, and the safety property that makes threading incremental: an
// un-threaded call site (keys === undefined) transparently uses the env key.
export interface ProviderKeys {
  anthropic?: string;
  openai?: string;
  openrouter?: string;
  browserbase?: { key: string; project: string };
  /** True when the user supplied ANY of their own keys (used for cap-lifting). */
  hasOwn?: boolean;
}

export function anthropicKey(keys?: ProviderKeys): string | undefined {
  return keys?.anthropic ?? process.env.ANTHROPIC_API_KEY;
}
export function openaiKey(keys?: ProviderKeys): string | undefined {
  return keys?.openai ?? process.env.OPENAI_API_KEY;
}
export function openrouterKey(keys?: ProviderKeys): string | undefined {
  return keys?.openrouter ?? process.env.OPENROUTER_API_KEY;
}
export function browserbaseCreds(keys?: ProviderKeys): {
  key: string | undefined;
  project: string | undefined;
} {
  return {
    key: keys?.browserbase?.key ?? process.env.BROWSERBASE_API_KEY,
    project: keys?.browserbase?.project ?? process.env.BROWSERBASE_PROJECT_ID,
  };
}
