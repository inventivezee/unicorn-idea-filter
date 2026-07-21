// Autonomous Cash Cow scorer — scores ONE discovery idea through the
// $20M-EBITDA instrument in a single web-search-enabled call (Opus 4.8 or
// GPT-5.6 Sol, alternating per idea, both at max effort), then writes the
// verdict onto ideas.cashcow. No reframe: we score, we don't filter.
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeCashCowAnalysis, type RawAnalysis } from "@/lib/ai/analysis";
import { buildCashCowSystemPrompt, buildUserPrompt } from "@/lib/ai/prompt";
import { CC_ANALYSIS_SCHEMA } from "@/lib/ai/schema";
import { callProviderJSON, parseLastJSON } from "@/lib/ai/server";
import { applyCashCowToIdea } from "@/lib/db/ideas";
import { CC_FOUNDER_PERSONAL_GATES } from "@/lib/cashcow/criteria";
import type { CashCowCandidate } from "@/lib/db/cashcowJobs";

/** Deterministic per-idea model pick so the corpus gets both scorers and a
 *  given idea always resolves the same way (idempotent retries). */
function scorerFor(ideaId: string): {
  provider: "anthropic" | "openai";
  model: string;
} {
  let h = 2166136261;
  for (let i = 0; i < ideaId.length; i++) {
    h ^= ideaId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 2 === 0
    ? { provider: "anthropic", model: "claude-opus-4-8" }
    : { provider: "openai", model: "gpt-5.6-sol" };
}

export async function scoreCashCow(
  admin: SupabaseClient,
  idea: CashCowCandidate,
): Promise<void> {
  const { provider, model } = scorerFor(idea.id);
  const userPrompt = buildUserPrompt(
    {
      name: idea.name,
      domain: idea.domain,
      businessModel: idea.business_model,
      buyerICP: idea.buyer_icp,
      initialWedge: idea.initial_wedge,
      thesisNotes: idea.thesis_notes,
    },
    "", // no founder background — discovery ideas are founder-anonymised
    [],
    [],
  );
  const result = await callProviderJSON({
    provider,
    model,
    system: buildCashCowSystemPrompt(null), // uncapped premium web search
    prompt: userPrompt,
    schemaName: "cashcow_analysis",
    schema: CC_ANALYSIS_SCHEMA as unknown as Record<string, unknown>,
    webSearch: true, // the model researches only if it needs to
    speed: "quality",
    tier: "premium",
    effort: "max",
    maxTokens: 32000, // max-effort verdict over a long idea needs headroom
    maxWebSearches: 15, // research if needed, but keep one call inside the window + cost sane
  });
  const raw = parseLastJSON<RawAnalysis>(result.texts);
  const verdict = normalizeCashCowAnalysis(
    raw,
    result.webSearches,
    provider,
    model,
  );
  // Founder-personal gates (cg_control) can't be confirmed autonomously —
  // resolve UNSURE optimistically so the idea doesn't sit PENDING forever
  // (mirrors the unicorn discovery scorer).
  for (const gid of CC_FOUNDER_PERSONAL_GATES) {
    if (verdict.gates[gid]?.value === "UNSURE") {
      verdict.gates[gid] = {
        value: "Y",
        rationale:
          "Assumed for an autonomously scored idea — confirm personally before building.",
      };
    }
  }
  await applyCashCowToIdea(admin, idea.id, verdict);
}
