// Discovery runs + tasks: the autonomous idea-discovery engine's job rows.
// Service-role-only access (like drafts); every caller goes through these
// helpers. Runs are ALWAYS owned by a signed-in subscriber — no anon_key.
//
// Concurrency model: each TASK row carries its own rev (CAS) plus a lease
// ({token, heartbeat_at}) so the every-minute cron and any pollers can race
// safely: turn counters are bumped in the same CAS that claims the task
// (spend counted BEFORE the provider call — invariant #1), and a claim is
// stealable only after CLAIM_LEASE_MS of heartbeat silence.
import type { SupabaseClient } from "@supabase/supabase-js";
import { CLAIM_LEASE_MS, RUN_DEADLINE_MS } from "@/lib/discovery/config";

export type RunStatus = "running" | "done" | "failed" | "cancelled";
export type TaskStatus =
  | "pending"
  | "researching"
  | "generated"
  | "scoring"
  | "reframing"
  | "rescoring"
  | "done"
  | "failed";

export interface DiscoveryRunRow {
  id: string;
  owner_id: string;
  status: RunStatus;
  guidelines: string;
  use_founder_background: boolean;
  budget: Record<string, unknown>;
  notified_at: string | null;
  rev: number;
  deadline_at: string;
  created_at: string;
  updated_at: string;
}

export interface DiscoveryTaskRow {
  id: string;
  run_id: string;
  idx: number;
  status: TaskStatus;
  generator: Record<string, unknown>;
  scorer: Record<string, unknown>;
  phase_state: Record<string, unknown>;
  turns: Record<string, number>;
  claim: { token: string; heartbeat_at: string } | null;
  bb: Record<string, unknown>;
  idea_original_id: string | null;
  idea_reframe_id: string | null;
  error: string | null;
  phase_started_at: string | null;
  rev: number;
  created_at: string;
  updated_at: string;
}

export class DiscoveryAccessError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** Hard ceiling on a task's serialized phase_state — the engine windows to
 *  TASK_STATE_CHAR_BUDGET well below this; breaching here is a code bug. */
const MAX_TASK_STATE_CHARS = 2_400_000; // 1.5× the window budget; breach = code bug (jsonb TOASTs fine)

function isUniqueViolation(error: { code?: string }): boolean {
  return error.code === "23505";
}
/** Pre-migration deploys: relation/constraint errors → clean 503. PostgREST
 *  reports missing tables/columns as PGRST205/PGRST204 (the codes the repo
 *  already tolerates in ideas.ts); the raw Postgres codes stay as defense. */
export function isMigrationDrift(error: { code?: string }): boolean {
  return (
    error.code === "PGRST205" ||
    error.code === "PGRST204" ||
    error.code === "42P01" ||
    error.code === "23514" ||
    error.code === "42703"
  );
}

export async function createRun(
  admin: SupabaseClient,
  ownerId: string,
  input: { guidelines: string; useFounderBackground: boolean },
): Promise<DiscoveryRunRow> {
  const { data, error } = await admin
    .from("discovery_runs")
    .insert({
      owner_id: ownerId,
      guidelines: input.guidelines,
      use_founder_background: input.useFounderBackground,
      budget: { totalTurns: 0, browserMinutes: 0 },
      // Explicit insert overrides the column's 24h default — deep runs
      // need the full window (RUN_DEADLINE_MS).
      deadline_at: new Date(Date.now() + RUN_DEADLINE_MS).toISOString(),
    })
    .select("*")
    .single<DiscoveryRunRow>();
  if (error) {
    if (isUniqueViolation(error)) {
      throw new DiscoveryAccessError(
        "A discovery run is already in progress — open it from Discover.",
        409,
      );
    }
    if (isMigrationDrift(error)) {
      throw new DiscoveryAccessError(
        "Discovery isn't available yet on this deployment (migration pending).",
        503,
      );
    }
    throw new DiscoveryAccessError(error.message, 500);
  }
  return data;
}

export async function createTasks(
  admin: SupabaseClient,
  rows: Array<{
    run_id: string;
    idx: number;
    generator: Record<string, unknown>;
    scorer: Record<string, unknown>;
    idea_original_id: string;
    idea_reframe_id: string;
  }>,
): Promise<void> {
  const { error } = await admin.from("discovery_tasks").insert(
    rows.map((r) => ({ ...r, turns: {}, phase_state: {}, bb: {} })),
  );
  // Idempotent under retry: (run_id, idx) unique — duplicates mean the
  // tasks already exist, which is success.
  if (error && !isUniqueViolation(error)) {
    throw new DiscoveryAccessError(error.message, 500);
  }
}

export async function fetchRun(
  admin: SupabaseClient,
  id: string,
): Promise<DiscoveryRunRow | null> {
  const { data, error } = await admin
    .from("discovery_runs")
    .select("*")
    .eq("id", id)
    .maybeSingle<DiscoveryRunRow>();
  if (error) throw new DiscoveryAccessError(error.message, 500);
  return data;
}

export async function fetchOwnedRun(
  admin: SupabaseClient,
  actor: { userId: string | null; isAdmin: boolean },
  id: string,
): Promise<DiscoveryRunRow> {
  const run = await fetchRun(admin, id);
  if (!run) throw new DiscoveryAccessError("Run not found.", 404);
  if (run.owner_id !== actor.userId && !actor.isAdmin) {
    throw new DiscoveryAccessError("You don't have access to this run.", 403);
  }
  return run;
}

export async function listOwnedRuns(
  admin: SupabaseClient,
  ownerId: string,
  limit = 20,
): Promise<DiscoveryRunRow[]> {
  const { data, error } = await admin
    .from("discovery_runs")
    .select("*")
    .eq("owner_id", ownerId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    if (isMigrationDrift(error)) return [];
    throw new DiscoveryAccessError(error.message, 500);
  }
  return (data ?? []) as DiscoveryRunRow[];
}

/** Active runs for the cron (oldest first so no run starves). */
export async function listActiveRuns(
  admin: SupabaseClient,
  limit = 50,
): Promise<DiscoveryRunRow[]> {
  const { data, error } = await admin
    .from("discovery_runs")
    .select("*")
    .eq("status", "running")
    .order("updated_at", { ascending: true })
    .limit(limit);
  if (error) {
    if (isMigrationDrift(error)) return [];
    throw new DiscoveryAccessError(error.message, 500);
  }
  return (data ?? []) as DiscoveryRunRow[];
}

export async function fetchTasks(
  admin: SupabaseClient,
  runId: string,
): Promise<DiscoveryTaskRow[]> {
  const { data, error } = await admin
    .from("discovery_tasks")
    .select("*")
    .eq("run_id", runId)
    .order("idx", { ascending: true });
  if (error) throw new DiscoveryAccessError(error.message, 500);
  return (data ?? []) as DiscoveryTaskRow[];
}

/** True when the task's lease is free or expired (stealable). */
export function claimAvailable(
  task: DiscoveryTaskRow,
  now = Date.now(),
): boolean {
  if (!task.claim?.heartbeat_at) return true;
  return now - new Date(task.claim.heartbeat_at).getTime() > CLAIM_LEASE_MS;
}

/**
 * CAS update on a task row — the ONLY write path for task state. Returns
 * null when another worker advanced the row first (caller re-reads; never
 * re-executes paid work it can't prove it owns via the claim token).
 */
export async function casUpdateTask(
  admin: SupabaseClient,
  id: string,
  expectedRev: number,
  patch: Partial<
    Pick<
      DiscoveryTaskRow,
      | "status"
      | "phase_state"
      | "turns"
      | "claim"
      | "bb"
      | "error"
      | "phase_started_at"
    >
  >,
): Promise<DiscoveryTaskRow | null> {
  if (
    patch.phase_state &&
    JSON.stringify(patch.phase_state).length > MAX_TASK_STATE_CHARS
  ) {
    throw new DiscoveryAccessError("Task state overflow (engine bug).", 413);
  }
  const { data, error } = await admin
    .from("discovery_tasks")
    .update({
      ...patch,
      rev: expectedRev + 1,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("rev", expectedRev)
    .select("*")
    .maybeSingle<DiscoveryTaskRow>();
  if (error) throw new DiscoveryAccessError(error.message, 500);
  return data ?? null;
}

/** CAS update on the run row (status transitions, notified_at flip). */
export async function casUpdateRun(
  admin: SupabaseClient,
  id: string,
  expectedRev: number,
  patch: Partial<
    Pick<DiscoveryRunRow, "status" | "budget" | "notified_at">
  >,
): Promise<DiscoveryRunRow | null> {
  const { data, error } = await admin
    .from("discovery_runs")
    .update({
      ...patch,
      rev: expectedRev + 1,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("rev", expectedRev)
    .select("*")
    .maybeSingle<DiscoveryRunRow>();
  if (error) throw new DiscoveryAccessError(error.message, 500);
  return data ?? null;
}

/** Best-effort event logging — NEVER throws, NEVER blocks the engine.
 *  Full untruncated detail (the task rows only keep short errors). */
export async function logEvent(
  admin: SupabaseClient,
  runId: string,
  taskIdx: number | null,
  kind: string,
  detail: string,
): Promise<void> {
  try {
    await admin.from("discovery_events").insert({
      run_id: runId,
      task_idx: taskIdx,
      kind,
      detail: detail.slice(0, 8000),
    });
  } catch {
    // Telemetry only (also tolerates the 012 migration not being applied).
  }
}

/** Prune old events (called opportunistically by the cron). */
export async function pruneEvents(admin: SupabaseClient): Promise<void> {
  try {
    await admin
      .from("discovery_events")
      .delete()
      .neq("kind", "reframe_loop") // loop records are analysis data — keep
      .neq("kind", "scoring_variant") // A/B assignments — keep for analysis
      .lt("created_at", new Date(Date.now() - 14 * 86400_000).toISOString());
  } catch {
    // Best-effort.
  }
}

/** Cancel is a monotonic status transition — a conditional UPDATE (not a
 *  rev CAS) so it can't lose to concurrent budget bumps; the user's brake
 *  must not be flaky exactly while a run is busiest. */
export async function cancelRun(
  admin: SupabaseClient,
  id: string,
): Promise<boolean> {
  const { data, error } = await admin
    .from("discovery_runs")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "running")
    .select("id")
    .maybeSingle<{ id: string }>();
  if (error) throw new DiscoveryAccessError(error.message, 500);
  return Boolean(data);
}

/** Terminal runs whose completion email may have been dropped (crash between
 *  the status flip and the send) — swept by the cron, bounded window. */
export async function listUnnotifiedTerminalRuns(
  admin: SupabaseClient,
  limit = 10,
): Promise<DiscoveryRunRow[]> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await admin
    .from("discovery_runs")
    .select("*")
    .in("status", ["done", "failed"])
    .is("notified_at", null)
    .gte("updated_at", since)
    .limit(limit);
  if (error) {
    if (isMigrationDrift(error)) return [];
    throw new DiscoveryAccessError(error.message, 500);
  }
  return (data ?? []) as DiscoveryRunRow[];
}

/**
 * Read-merge-retry for run-level budget counters (turns/browser minutes):
 * a sibling task's concurrent bump must never be lost NOR trigger paid-work
 * re-execution — this only ever moves counters forward.
 */
export async function bumpRunBudget(
  admin: SupabaseClient,
  runId: string,
  delta: { totalTurns?: number; browserMinutes?: number },
  attempts = 5,
): Promise<DiscoveryRunRow | null> {
  for (let i = 0; i < attempts; i++) {
    const run = await fetchRun(admin, runId);
    if (!run) return null;
    const budget = { ...(run.budget ?? {}) } as {
      totalTurns?: number;
      browserMinutes?: number;
    };
    budget.totalTurns = (budget.totalTurns ?? 0) + (delta.totalTurns ?? 0);
    budget.browserMinutes =
      (budget.browserMinutes ?? 0) + (delta.browserMinutes ?? 0);
    const updated = await casUpdateRun(admin, runId, run.rev, {
      budget: budget as Record<string, unknown>,
    });
    if (updated) return updated;
  }
  return null;
}
