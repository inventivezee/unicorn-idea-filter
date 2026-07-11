// Shared discovery-run creation — used by the user-facing POST route and
// the autopilot cron. Owns the full sequence: run row → spend metering →
// daily caps (fail closed) → weighted panel → task rows with deterministic
// idea ids. Any failure after the run row exists marks the run failed so
// the cron never spins on a task-less run.
import type { SupabaseClient } from "@supabase/supabase-js";
import { createRun, createTasks } from "@/lib/db/discovery";
import { taskIdeaIds } from "@/lib/discovery/engine";
import {
  MAX_TASKS_PER_RUN,
  buildRunPanel,
  globalDailyCap,
  pickScorer,
  userDailyCap,
} from "@/lib/discovery/config";

function todayStartIso(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

export class DiscoveryCapError extends Error {}

export async function startDiscoveryRun(
  admin: SupabaseClient,
  ownerId: string,
  opts: {
    guidelines: string;
    useFounderBackground: boolean;
    candidates: number;
    /** Admins bypass the daily-cap envs (matches the POST route). */
    bypassCaps?: boolean;
  },
): Promise<{ runId: string }> {
  const candidates = Math.min(
    MAX_TASKS_PER_RUN,
    Math.max(1, Math.round(opts.candidates) || 1),
  );
  const run = await createRun(admin, ownerId, {
    guidelines: opts.guidelines,
    useFounderBackground: opts.useFounderBackground,
  });
  try {
    // Meter FIRST, then count including our own row (bounds cap races to
    // truly-simultaneous inserts). Both caps enforced independently when
    // set; a failed count fails CLOSED.
    await admin.from("submission_logs").insert({
      user_id: ownerId,
      action: "discovery_run",
    });
    if (!opts.bypassCaps) {
      const overCap = async (
        cap: number | null,
        scopeToUser: boolean,
      ): Promise<boolean> => {
        if (cap === null) return false;
        let query = admin
          .from("submission_logs")
          .select("id", { count: "exact", head: true })
          .eq("action", "discovery_run")
          .gte("created_at", todayStartIso());
        if (scopeToUser) query = query.eq("user_id", ownerId);
        const { count, error } = await query;
        if (error || count === null || count === undefined) return true;
        return count > cap;
      };
      if (
        (await overCap(userDailyCap(), true)) ||
        (await overCap(globalDailyCap(), false))
      ) {
        await admin
          .from("discovery_runs")
          .update({ status: "failed" })
          .eq("id", run.id);
        throw new DiscoveryCapError(
          "Discovery is at capacity today — try again tomorrow.",
        );
      }
    }
    const panel = buildRunPanel(candidates);
    const rows = panel.map((generator, idx) => {
      const ids = taskIdeaIds(run.id, idx);
      return {
        run_id: run.id,
        idx,
        generator: generator as unknown as Record<string, unknown>,
        scorer: pickScorer(generator, idx) as unknown as Record<
          string,
          unknown
        >,
        idea_original_id: ids.original,
        idea_reframe_id: ids.reframe,
      };
    });
    await createTasks(admin, rows);
  } catch (err) {
    if (!(err instanceof DiscoveryCapError)) {
      await admin
        .from("discovery_runs")
        .update({ status: "failed" })
        .eq("id", run.id);
    }
    throw err;
  }
  return { runId: run.id };
}
