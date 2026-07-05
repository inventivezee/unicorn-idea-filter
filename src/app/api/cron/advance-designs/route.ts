// Vercel Cron (every minute, see vercel.json): advances every running
// filter-design chain server-side, so a founder can close their browser
// entirely and the three-model design keeps progressing. Each advance is one
// provider round-trip and every paid submission sits behind the chain's
// CAS-claimed, budget-counted protocol — so this endpoint can safely overlap
// with client polling and with itself (a slow run overlapping the next
// minute's run cannot double-spend).
//
// Auth: Vercel automatically sends `Authorization: Bearer ${CRON_SECRET}`
// with cron invocations when the CRON_SECRET env var is set. Fail closed —
// no secret configured means no advancing.
import { advanceDraftChain, chainStateFrom } from "@/lib/ai/design-chain";
import type { DraftRow } from "@/lib/db/drafts";
import { adminClient, cloudConfigured } from "@/lib/supabase/server";

export const maxDuration = 800; // Vercel Pro (GA limit; build fails on Hobby)

// One designing row per signed-in user is DB-enforced, so this is really
// "number of users mid-design at once". Pending polls don't touch
// updated_at, so a small stalest-first window would re-select the same rows
// every minute and starve the tail — instead: fetch a far-beyond-realistic
// bound, shuffle so no fixed prefix wins, and stop at a time budget.
const MAX_JOBS_PER_RUN = 250;
const TIME_BUDGET_MS = 600_000; // leave headroom inside the 800s window

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return Response.json(
      { error: "CRON_SECRET is not configured on this deployment." },
      { status: 503 },
    );
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  if (!cloudConfigured()) {
    return Response.json({ error: "Cloud not configured." }, { status: 503 });
  }

  const admin = adminClient();
  const { data, error } = await admin
    .from("drafts")
    .select("*")
    .eq("kind", "filter")
    .eq("status", "designing")
    .limit(MAX_JOBS_PER_RUN);
  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  const jobs = (data ?? []) as DraftRow[];
  // Fisher-Yates shuffle: every job gets an equal shot at each minute's run,
  // even if a time-budget cutoff ends a run early.
  for (let i = jobs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [jobs[i], jobs[j]] = [jobs[j], jobs[i]];
  }
  const startedAt = Date.now();
  const results: {
    id: string;
    status: string;
    stage: number | null;
    error?: string;
  }[] = [];
  // Sequential on purpose: each step is a quick provider check, volumes are
  // tiny, and it keeps provider/API rate usage flat.
  let skipped = 0;
  for (const job of jobs) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) {
      skipped = jobs.length - results.length;
      break; // next minute's shuffled run picks up the rest
    }
    try {
      const advanced = await advanceDraftChain(admin, job);
      results.push({
        id: job.id,
        status: advanced.status,
        stage:
          chainStateFrom(
            (advanced.payload as Record<string, unknown>).chain,
          )?.stage ?? null,
      });
    } catch (err) {
      // One stuck job must not stop the rest; its own deadline/budget
      // machinery will eventually fail it.
      results.push({
        id: job.id,
        status: "error",
        stage: null,
        error: err instanceof Error ? err.message.slice(0, 200) : "unknown",
      });
    }
  }

  return Response.json({ checked: results.length, skipped, results });
}
