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

const CANDIDATE_COLUMNS =
  "id, name, domain, business_model, buyer_icp, initial_wedge, thesis_notes";

/** Discovery ideas that have NOT yet been Cash-Cow-scored (no cashcow.ai)
 *  and are claimable right now. A scored idea drops out automatically once
 *  applyCashCowToIdea runs. */
export async function listCashCowCandidates(
  admin: SupabaseClient,
  limit: number,
): Promise<CashCowCandidate[]> {
  try {
    const ids = await candidateIds(admin, limit);
    if (ids.length === 0) return [];
    const { data, error } = await admin
      .from("ideas")
      .select(CANDIDATE_COLUMNS)
      .in("id", ids);
    if (error) return [];
    const byId = new Map(
      ((data ?? []) as CashCowCandidate[]).map((row) => [row.id, row]),
    );
    // Preserve the oldest-first order the selector returned.
    return ids
      .map((id) => byId.get(id))
      .filter((row): row is CashCowCandidate => Boolean(row));
  } catch {
    return [];
  }
}

/** Oldest scoreable idea ids. The migration-021 RPC does the anti-join in
 *  SQL so the window SLIDES PAST blocked rows — filtering a fixed client-side
 *  window instead let a fully-blocked head of queue freeze the pipeline
 *  indefinitely. Falls back to the client-side filter when 021 hasn't run. */
async function candidateIds(
  admin: SupabaseClient,
  limit: number,
): Promise<string[]> {
  const { data, error } = await admin.rpc("list_cashcow_candidate_ids", {
    p_limit: limit,
    p_max_attempts: CASHCOW_MAX_ATTEMPTS,
  });
  if (!error && Array.isArray(data)) {
    return data
      .map((row: unknown) =>
        typeof row === "string"
          ? row
          : ((row as { idea_id?: string })?.idea_id ?? ""),
      )
      .filter(Boolean);
  }
  return legacyCandidateIds(admin, limit);
}

/** Pre-021 path: over-fetch, then drop blocked rows in JS. Cannot slide past
 *  a fully-blocked window — kept only so a missing migration degrades
 *  instead of breaking (invariant 5). */
async function legacyCandidateIds(
  admin: SupabaseClient,
  limit: number,
): Promise<string[]> {
  const { data, error } = await admin
    .from("ideas")
    .select("id")
    .eq("origin", "discovery")
    .or("cashcow.is.null,cashcow->ai.is.null")
    .order("created_at", { ascending: true })
    .limit(Math.max(limit * 8, 100));
  if (error) return [];
  const pool = ((data ?? []) as { id: string }[]).map((row) => row.id);
  if (pool.length === 0) return [];
  const blocked = await blockedIdeaIds(admin, pool);
  return pool.filter((id) => !blocked.has(id)).slice(0, limit);
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
    j.status === "done" ||
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

export type FailureKind = "auth" | "quota" | "infra" | "fatal";

export interface ProviderFailure {
  /** Transient failures refund the attempt and retry after the backoff;
   *  fatal ones consume an attempt and eventually kill the job. */
  transient: boolean;
  backoffSeconds: number;
  kind: FailureKind;
}

/** Classify a provider error. Getting this wrong is expensive in BOTH
 *  directions: calling a real outage "fatal" permanently kills ideas that
 *  were never at fault (a 500 burst killed 44 of them once), and calling an
 *  idea-specific failure "transient" bills the same doomed call forever. */
export function classifyProviderError(msg: string): ProviderFailure {
  // Deployment/config problem — a disabled or rotated key. Not the idea's
  // fault, so never spend its attempts; back off long because a broken key
  // is fixed by a human, not by waiting.
  if (
    /\b(401|403)\b|authentication_error|permission_error|invalid_api_key|invalid x-api-key|api key is invalid|unauthorized/i.test(
      msg,
    )
  ) {
    return { transient: true, backoffSeconds: 21_600, kind: "auth" };
  }
  // Spend or rate ceiling — recovers on the account's own schedule.
  if (
    /\b429\b|quota|rate.?limit|billing|credit balance|insufficient_quota/i.test(
      msg,
    )
  ) {
    return { transient: true, backoffSeconds: 3_600, kind: "quota" };
  }
  // Provider-side outage or network fault — retry soon.
  if (
    /\b(500|502|503|504|520|521|522|524|529)\b|internal server error|overloaded|upstream connect|connection termination|timed out|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|fetch failed|terminated/i.test(
      msg,
    )
  ) {
    return { transient: true, backoffSeconds: 300, kind: "infra" };
  }
  // Repeatable and idea-specific (unparseable output, over the output
  // ceiling) — this one really is the job's own fault.
  return { transient: false, backoffSeconds: 0, kind: "fatal" };
}

export function isTransientProviderError(msg: string): boolean {
  return classifyProviderError(msg).transient;
}

/** Transient provider failure: put the job back to pending, refund the
 *  claim's attempt bump, and hold it out of the candidate window for
 *  `backoffSeconds` so a dead provider can't head-of-line-block the queue. */
export async function releaseCashCowJobTransient(
  admin: SupabaseClient,
  ideaId: string,
  error?: string,
  backoffSeconds = 300,
): Promise<void> {
  try {
    const { error: rpcErr } = await admin.rpc("release_cashcow_job_transient", {
      p_idea: ideaId,
      p_backoff: backoffSeconds,
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
