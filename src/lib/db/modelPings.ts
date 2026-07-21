// The model-call ledger: one row per provider call, with purpose and an
// estimated price. NEVER throws, NEVER blocks the calling path — a broken
// ledger must not break a paid call that already succeeded. No-ops when
// cloud isn't configured (local-only mode) or migration 019 hasn't run.
import { estimateCostUsd, type PingUsage } from "@/lib/ai/pricing";
import { adminClient, cloudConfigured } from "@/lib/supabase/server";

export async function recordModelPing(entry: {
  provider: string;
  model: string;
  /** Why the call happened, e.g. 'analyze:idea_analysis',
   *  'discovery:rescoring', 'cashcow_auto', 'critique'. */
  purpose: string;
  /** Correlation id — idea id, runId:taskIdx, etc. */
  ref?: string;
  usage?: PingUsage;
}): Promise<void> {
  try {
    if (!cloudConfigured()) return;
    const u = entry.usage ?? {};
    await adminClient()
      .from("model_pings")
      .insert({
        provider: entry.provider,
        model: entry.model,
        purpose: entry.purpose.slice(0, 120),
        ref: entry.ref?.slice(0, 120) ?? null,
        in_tokens: u.inTokens ?? null,
        cached_in_tokens: u.cachedInTokens ?? null,
        cache_write_tokens: u.cacheWriteTokens ?? null,
        out_tokens: u.outTokens ?? null,
        web_searches: u.webSearches ?? null,
        est_cost_usd: estimateCostUsd(entry.model, u),
      });
  } catch {
    // Telemetry only — never interfere with the call path.
  }
}
