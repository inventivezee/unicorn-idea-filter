// Discovery runs: start (POST) and list (GET). Subscriber-only (admin
// bypasses), cloud-only, and requires all discovery provider keys — missing
// pieces degrade to clear 503s (never crashes; invariant #5).
import { guardRequest, readJsonBody } from "@/lib/ai/server";
import {
  DiscoveryAccessError,
  createRun,
  createTasks,
  fetchTasks,
  listOwnedRuns,
} from "@/lib/db/discovery";
import { taskIdeaIds } from "@/lib/discovery/engine";
import {
  buildRunPanel,
  discoveryConfigured,
  globalDailyCap,
  pickScorer,
  userDailyCap,
} from "@/lib/discovery/config";
import {
  adminClient,
  cloudConfigured,
  resolveCaller,
} from "@/lib/supabase/server";

export const maxDuration = 60;

function todayStartIso(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

export async function POST(request: Request) {
  const guard = guardRequest(request);
  if (guard) return guard;
  if (!cloudConfigured()) {
    return Response.json(
      { error: "Discovery needs the cloud deployment." },
      { status: 503 },
    );
  }
  const caller = await resolveCaller();
  if (!caller.user) {
    return Response.json(
      { error: "Sign in to run discovery.", signIn: true },
      { status: 401 },
    );
  }
  if (!caller.subscribed && !caller.isAdmin) {
    return Response.json(
      {
        error: "Autonomous discovery is a subscriber feature.",
        upgrade: true,
      },
      { status: 402 },
    );
  }
  if (!discoveryConfigured()) {
    return Response.json(
      {
        error:
          "Discovery isn't configured on this deployment (needs OPENROUTER_API_KEY, BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID plus both AI keys).",
      },
      { status: 503 },
    );
  }

  const body = await readJsonBody(request);
  if (!body) {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const guidelines =
    typeof body.guidelines === "string"
      ? body.guidelines.trim().slice(0, 20000)
      : "";
  const useFounderBackground = body.useFounderBackground !== false; // default ON

  const admin = adminClient();
  try {
    // 1. The run row IS the concurrency slot (partial unique index).
    const run = await createRun(admin, caller.user.id, {
      guidelines,
      useFounderBackground,
    });

    // Everything after the run row exists must mark the run failed on ANY
    // error — otherwise the partial unique index blocks the owner's slot
    // for 24h and the cron spins on a task-less run.
    try {
      // 2. Meter FIRST, then count including our own row (bounds cap races
      //    to truly-simultaneous inserts). BOTH caps are enforced
      //    independently when set; a failed count fails CLOSED.
      await admin.from("submission_logs").insert({
        user_id: caller.user.id,
        action: "discovery_run",
      });
      const userCap = userDailyCap();
      const globalCap = globalDailyCap();
      if (!caller.isAdmin) {
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
          if (scopeToUser) query = query.eq("user_id", caller.user!.id);
          const { count, error } = await query;
          if (error || count === null || count === undefined) return true; // fail closed
          return count > cap;
        };
        if ((await overCap(userCap, true)) || (await overCap(globalCap, false))) {
          await admin
            .from("discovery_runs")
            .update({ status: "failed" })
            .eq("id", run.id);
          return Response.json(
            { error: "Discovery is at capacity today — try again tomorrow." },
            { status: 429 },
          );
        }
      }

      // 3. Tasks from the weighted panel (30% Sol / 30% Fable / rest even),
      //    scorer picked cross-vendor, deterministic idea ids assigned NOW
      //    (crash-safe publishing).
      const panel = buildRunPanel();
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
      await admin
        .from("discovery_runs")
        .update({ status: "failed" })
        .eq("id", run.id);
      throw err;
    }

    return Response.json({ runId: run.id, status: "running" });
  } catch (err) {
    if (err instanceof DiscoveryAccessError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}

export async function GET(request: Request) {
  const guard = guardRequest(request);
  if (guard) return guard;
  if (!cloudConfigured()) return Response.json({ runs: [] });
  const caller = await resolveCaller();
  if (!caller.user) return Response.json({ runs: [] });
  const admin = adminClient();
  const runs = await listOwnedRuns(admin, caller.user.id);
  // Attach task summaries for the most recent runs (grid UI).
  const withTasks = await Promise.all(
    runs.slice(0, 5).map(async (run) => ({
      ...runSummary(run),
      tasks: (await fetchTasks(admin, run.id)).map(taskSummary),
    })),
  );
  return Response.json({
    runs: [...withTasks, ...runs.slice(5).map(runSummary)],
  });
}

function runSummary(run: {
  id: string;
  status: string;
  guidelines: string;
  created_at: string;
  budget: Record<string, unknown>;
}) {
  return {
    id: run.id,
    status: run.status,
    guidelines: run.guidelines,
    createdAt: run.created_at,
    budget: run.budget,
  };
}

function taskSummary(t: {
  idx: number;
  status: string;
  generator: Record<string, unknown>;
  error: string | null;
  idea_original_id: string | null;
  idea_reframe_id: string | null;
  phase_state: Record<string, unknown>;
}) {
  const idea = (t.phase_state as { idea?: { name?: string } }).idea;
  return {
    idx: t.idx,
    status: t.status,
    model: (t.generator as { model?: string }).model ?? "",
    error: t.error,
    ideaName: idea?.name ?? null,
    originalId: t.idea_original_id,
    reframeId: t.idea_reframe_id,
  };
}
