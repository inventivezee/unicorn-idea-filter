// Per-model pricing for the model-call ledger (model_pings). Anthropic
// prices are authoritative (docs, 2026-10): Fable 5.1 $10/$50 (cache reads
// $0.25), Opus 5.5 $4/$20 (cache reads $0.20), Sonnet 5.5 $2/$10 per MTok;
// cache reads bill ~0.1x input unless overridden, cache writes ~1.25x
// (5-min TTL). Non-Anthropic prices are ESTIMATES — update when bills
// disagree. Unknown models record usage with est_cost null. Superseded ids
// stay priced while in-flight work pinned to them drains.
interface ModelPrice {
  inPerMTok: number;
  outPerMTok: number;
  /** Cache-read multiplier when it differs from CACHE_READ_MULT. */
  cacheReadMult?: number;
}

const PRICES: Record<string, ModelPrice> = {
  "claude-fable-5-1": { inPerMTok: 10, outPerMTok: 50, cacheReadMult: 0.025 },
  "claude-opus-5-5": { inPerMTok: 4, outPerMTok: 20, cacheReadMult: 0.05 },
  "claude-sonnet-5-5": { inPerMTok: 2, outPerMTok: 10 },
  "claude-fable-5": { inPerMTok: 10, outPerMTok: 50 },
  "claude-opus-4-8": { inPerMTok: 5, outPerMTok: 25 },
  "claude-sonnet-5": { inPerMTok: 3, outPerMTok: 15 },
  "claude-haiku-4-5": { inPerMTok: 1, outPerMTok: 5 },
  // gpt-6.1-sol list price $2/$10, cached input $0.10. Pro-mode calls bill
  // far more reasoning tokens, which output tokens already capture.
  "gpt-6.1-sol": { inPerMTok: 2, outPerMTok: 10, cacheReadMult: 0.05 },
  // Estimates:
  "gpt-5.6-sol": { inPerMTok: 5, outPerMTok: 30 },
  "deepseek/deepseek-v4-pro-0813": { inPerMTok: 0.14, outPerMTok: 0.4 },
  "deepseek/deepseek-v4-pro": { inPerMTok: 0.6, outPerMTok: 2.5 },
  "qwen/qwen3.8-max": { inPerMTok: 2, outPerMTok: 6 },
  "qwen/qwen3.7-max": { inPerMTok: 1.2, outPerMTok: 5 },
  "google/gemini-3.1-pro-preview": { inPerMTok: 2, outPerMTok: 10 },
};

const CACHE_READ_MULT = 0.1;
const CACHE_WRITE_MULT = 1.25;
const WEB_SEARCH_PER_1000 = 10; // estimate — Anthropic web search tool

export interface PingUsage {
  inTokens?: number;
  cachedInTokens?: number;
  cacheWriteTokens?: number;
  outTokens?: number;
  webSearches?: number;
}

/** Estimated USD cost of one call; null when the model isn't priced. */
export function estimateCostUsd(
  model: string,
  usage: PingUsage,
): number | null {
  const p = PRICES[model];
  if (!p) return null;
  const cost =
    ((usage.inTokens ?? 0) / 1e6) * p.inPerMTok +
    ((usage.cachedInTokens ?? 0) / 1e6) *
      p.inPerMTok *
      (p.cacheReadMult ?? CACHE_READ_MULT) +
    ((usage.cacheWriteTokens ?? 0) / 1e6) * p.inPerMTok * CACHE_WRITE_MULT +
    ((usage.outTokens ?? 0) / 1e6) * p.outPerMTok +
    ((usage.webSearches ?? 0) / 1000) * WEB_SEARCH_PER_1000;
  return Math.round(cost * 1e6) / 1e6;
}
