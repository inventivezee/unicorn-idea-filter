// DAL for the Cash Cow auto-scoring queue. The job row is a claim/lock +
// failure tracker; the verdict itself lands on ideas.cashcow. Drift-tolerant:
// if migration 017 hasn't run, claim returns false (nothing gets scored)
// rather than throwing.
import type { SupabaseClient } from "@supabase/supabase-js";

export const CASHCOW_MAX_ATTEMPTS = 3;
export const CASHCOW_LEASE_SECONDS = 300; // a single web-search call is minutes, not hours

export interface CashCowCandidate {
  id: string;
  name: string;
  domain: string;
  business_model: string;
  buyer_icp: string;
  initial_wedge: string;
  thesis_notes: string;
}

/** Discovery ideas that have NOT yet been Cash-Cow-scored (no cashcow.ai).
 *  A scored idea drops out here automatically once applyCashCowToIdea runs. */
export async function listCashCowCandidates(
  admin: SupabaseClient,
  limit: number,
): Promise<CashCowCandidate[]> {
  try {
    const { data, error } = await admin
      .from("ideas")
      .select(
        "id, name, domain, business_model, buyer_icp, initial_wedge, thesis_notes",
      )
      .eq("origin", "discovery")
      .or("cashcow.is.null,cashcow->ai.is.null")
      .order("created_at", { ascending: true })
      .limit(limit);
    if (error) return [];
    return (data ?? []) as CashCowCandidate[];
  } catch {
    return [];
  }
}

/** Atomic claim via the migration-017 RPC. Returns true iff we won it. */
export async function claimCashCowJob(
  admin: SupabaseClient,
  ideaId: string,
  token: string,
): Promise<boolean> {
  try {
    const { data, error } = await admin.rpc("claim_cashcow_job", {
      p_idea: ideaId,
      p_token: token,
      p_lease: CASHCOW_LEASE_SECONDS,
      p_max: CASHCOW_MAX_ATTEMPTS,
    });
    if (error) return false;
    return data === true;
  } catch {
    return false;
  }
}

/** Transient provider failure (429/quota/rate-limit): put the job back to
 *  pending and refund the claim's attempt bump, so a temporary outage never
 *  exhausts the cap and permanently kills the idea. */
export async function releaseCashCowJobTransient(
  admin: SupabaseClient,
  ideaId: string,
): Promise<void> {
  try {
    await admin.rpc("release_cashcow_job_transient", { p_idea: ideaId });
  } catch {
    // Best-effort — lease expiry is the backstop.
  }
}

export function isTransientProviderError(msg: string): boolean {
  return /\b429\b|quota|rate.?limit|overloaded|billing|timeout|ETIMEDOUT|ECONNRESET|terminated/i.test(
    msg,
  );
}

export async function finishCashCowJob(
  admin: SupabaseClient,
  ideaId: string,
  status: "done" | "failed",
  error?: string,
): Promise<void> {
  try {
    await admin
      .from("cashcow_jobs")
      .update({
        status,
        error: error?.slice(0, 500) ?? null,
        claim: null,
        updated_at: new Date().toISOString(),
      })
      .eq("idea_id", ideaId);
  } catch {
    // Best-effort — the lease expiry is the backstop for a lost update.
  }
}
