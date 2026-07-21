// DAL for the Cash Cow auto-scoring queue. The job row is a claim/lock +
// failure tracker; the verdict itself lands on ideas.cashcow. Drift-tolerant:
// if migration 017 hasn't run, claim returns false (nothing gets scored)
// rather than throwing.
import type { SupabaseClient } from "@supabase/supabase-js";

export const CASHCOW_MAX_ATTEMPTS = 3;
export const CASHCOW_LEASE_SECONDS = 1900; // must outlast the longest call (30-min window)

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
 *  A scored idea drops out here automatically once applyCashCowToIdea runs.
 *
 *  Head-of-line guard: fetches a pool much larger than `limit`, then drops
 *  ideas whose job row is failed, at the attempt cap, or inside a transient
 *  backoff window. Without this, quota-blocked ideas accumulate at the head
 *  of the oldest-first order until the whole fetch window is unscoreable and
 *  the queue freezes (9-hour production stall, 2026-07-21). */
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
      .limit(Math.max(limit * 8, 100));
    if (error) return [];
    const pool = (data ?? []) as CashCowCandidate[];
    if (pool.length === 0) return [];
    const blocked = await blockedIdeaIds(
      admin,
      pool.map((c) => c.id),
    );
    return pool.filter((c) => !blocked.has(c.id)).slice(0, limit);
  } catch {
    return [];
  }
}

/** Job rows that must NOT be handed out as candidates right now. Tolerates
 *  a missing next_attempt_at column (migration 020 not yet applied) by
 *  falling back to status/attempts filtering only. */
async function blockedIdeaIds(
  admin: SupabaseClient,
  ideaIds: string[],
): Promise<Set<string>> {
  const isBlocked = (j: {
    idea_id: string;
    status?: string | null;
    attempts?: number | null;
    next_attempt_at?: string | null;
  }) =>
    j.status === "failed" ||
    (j.attempts ?? 0) >= CASHCOW_MAX_ATTEMPTS ||
    (typeof j.next_attempt_at === "string" &&
      Date.parse(j.next_attempt_at) > Date.now());
  for (const cols of [
    "idea_id, status, attempts, next_attempt_at",
    "idea_id, status, attempts",
  ]) {
    const { data, error } = await admin
      .from("cashcow_jobs")
      .select(cols)
      .in("idea_id", ideaIds);
    if (!error) {
      const rows = (data ?? []) as unknown as Parameters<typeof isBlocked>[0][];
      return new Set(rows.filter(isBlocked).map((j) => j.idea_id));
    }
  }
  return new Set();
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
  error?: string,
): Promise<void> {
  try {
    // Quota exhaustion won't recover in minutes — back off an hour so the
    // idea steps out of the candidate window. Other transients retry soon.
    const backoff = /\b429\b|quota|billing/i.test(error ?? "") ? 3600 : 300;
    const { error: rpcErr } = await admin.rpc("release_cashcow_job_transient", {
      p_idea: ideaId,
      p_backoff: backoff,
    });
    if (rpcErr) {
      // Migration 020 not applied yet — fall back to the 018 signature.
      await admin.rpc("release_cashcow_job_transient", { p_idea: ideaId });
    }
    if (error) {
      // Record WHY even for transient failures — a repeating transient
      // error cycled invisibly for 9 hours before this existed.
      await admin
        .from("cashcow_jobs")
        .update({ error: error.slice(0, 500) })
        .eq("idea_id", ideaId);
    }
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
