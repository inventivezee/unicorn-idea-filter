// Discovery runs: start (POST) and list (GET). Subscriber-only (admin
// bypasses), cloud-only, and requires all discovery provider keys — missing
// pieces degrade to clear 503s (never crashes; invariant #5).
import { guardRequest, readJsonBody } from "@/lib/ai/server";
import {
  DiscoveryAccessError,
  fetchTasks,
  listOwnedRuns,
} from "@/lib/db/discovery";
import {
  DiscoveryCapError,
  startDiscoveryRun,
} from "@/lib/discovery/create";
import {
  DEFAULT_TASKS_PER_RUN,
  MAX_TASKS_PER_RUN,
  discoveryConfigured,
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
  const candidates = Math.min(
    MAX_TASKS_PER_RUN,
    Math.max(
      1,
      Math.round(Number(body.candidates) || DEFAULT_TASKS_PER_RUN),
    ),
  );

  const admin = adminClient();
  try {
    const { runId } = await startDiscoveryRun(admin, caller.user.id, {
      guidelines,
      useFounderBackground,
      candidates,
      bypassCaps: caller.isAdmin,
    });
    return Response.json({ runId, status: "running" });
  } catch (err) {
    if (err instanceof DiscoveryCapError) {
      return Response.json({ error: err.message }, { status: 429 });
    }
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
