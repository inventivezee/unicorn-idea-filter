// One discovery run: read-only status (GET — the cron is the engine, the
// poll is the dashboard) and cancel (DELETE).
import { guardRequest } from "@/lib/ai/server";
import {
  DiscoveryAccessError,
  cancelRun,
  fetchOwnedRun,
  fetchTasks,
} from "@/lib/db/discovery";
import { releaseSessionById } from "@/lib/discovery/browserbase";
import {
  adminClient,
  cloudConfigured,
  resolveCaller,
} from "@/lib/supabase/server";

export const maxDuration = 30;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = guardRequest(request);
  if (guard) return guard;
  if (!cloudConfigured()) {
    return Response.json({ error: "Cloud not configured." }, { status: 503 });
  }
  const caller = await resolveCaller();
  const { id } = await params;
  const admin = adminClient();
  try {
    const run = await fetchOwnedRun(
      admin,
      { userId: caller.user?.id ?? null, isAdmin: caller.isAdmin },
      id,
    );
    const tasks = await fetchTasks(admin, run.id);
    return Response.json({
      id: run.id,
      status: run.status,
      guidelines: run.guidelines,
      createdAt: run.created_at,
      budget: run.budget,
      tasks: tasks.map((t) => ({
        idx: t.idx,
        status: t.status,
        model: (t.generator as { model?: string }).model ?? "",
        error: t.error,
        ideaName:
          (t.phase_state as { idea?: { name?: string } }).idea?.name ?? null,
        originalId: t.idea_original_id,
        reframeId: t.idea_reframe_id,
        turns: t.turns,
      })),
    });
  } catch (err) {
    if (err instanceof DiscoveryAccessError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = guardRequest(request);
  if (guard) return guard;
  if (!cloudConfigured()) {
    return Response.json({ error: "Cloud not configured." }, { status: 503 });
  }
  const caller = await resolveCaller();
  const { id } = await params;
  const admin = adminClient();
  try {
    const run = await fetchOwnedRun(
      admin,
      { userId: caller.user?.id ?? null, isAdmin: caller.isAdmin },
      id,
    );
    if (run.status !== "running") {
      return Response.json({ status: run.status });
    }
    // Conditional UPDATE (not rev CAS) — the brake must not lose to
    // concurrent budget bumps. In-flight chunks notice the status change
    // between turns; Browserbase sessions are released best-effort here
    // (their timeouts are the backstop). Counts against daily caps by design.
    const cancelled = await cancelRun(admin, run.id);
    const tasks = await fetchTasks(admin, run.id);
    await Promise.all(
      tasks
        .map((t) => (t.bb as { sessionId?: string }).sessionId)
        .filter((sid): sid is string => Boolean(sid))
        .map((sid) => releaseSessionById(sid)),
    );
    return Response.json({ status: cancelled ? "cancelled" : run.status });
  } catch (err) {
    if (err instanceof DiscoveryAccessError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
