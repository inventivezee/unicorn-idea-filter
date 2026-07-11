// Vercel cron: advances discovery runs browserlessly, every minute. Same
// fail-closed auth contract as advance-designs: 503 when CRON_SECRET is
// unset, 401 on mismatch, 200 {checked, results} when healthy.
import {
  advanceDiscoveryRun,
  newSessionHolder,
  sweepNotifications,
} from "@/lib/discovery/engine";
import { releaseBrowserSession } from "@/lib/discovery/browserbase";
import { CRON_TIME_BUDGET_MS, discoveryConfigured } from "@/lib/discovery/config";
import { listActiveRuns, pruneEvents } from "@/lib/db/discovery";
import { adminClient, cloudConfigured } from "@/lib/supabase/server";

// 30-min extended duration (Vercel Pro beta for Node.js runtimes) — the
// research worker gets the longest window Vercel offers; the wall-clock
// budget below leaves 5 min of headroom before the hard kill.
export const maxDuration = 1800;

const TIME_BUDGET_MS = CRON_TIME_BUDGET_MS;

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
  if (!discoveryConfigured()) {
    // Not an error — the feature simply isn't enabled yet.
    return Response.json({ checked: 0, results: [], disabled: true });
  }

  const admin = adminClient();
  // Recover completion emails dropped by a crash between the terminal
  // status flip and the send (bounded 24h window; single-winner CAS inside).
  try {
    await sweepNotifications(admin);
    await pruneEvents(admin);
  } catch {
    // Sweeps are best-effort — never block advancement.
  }
  const runs = await listActiveRuns(admin);
  // Shuffle for fair scheduling under the time budget.
  for (let i = runs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [runs[i], runs[j]] = [runs[j], runs[i]];
  }

  const invocationDeadline = Date.now() + TIME_BUDGET_MS;
  const results: Array<Record<string, unknown>> = [];
  let checked = 0;
  // ONE Browserbase session for the whole invocation, shared across runs —
  // per-run sessions multiplied under concurrent batches (8 runs x ~25
  // overlapping invocations) far past the account's session cap.
  const holder = newSessionHolder();
  try {
    for (const run of runs) {
      if (Date.now() > invocationDeadline - 60_000) break;
      checked++;
      try {
        const result = await advanceDiscoveryRun(
          admin,
          run,
          invocationDeadline,
          holder,
        );
        results.push(result as unknown as Record<string, unknown>);
      } catch (err) {
        results.push({
          runId: run.id,
          status: "error",
          error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
        });
      }
    }
  } finally {
    await releaseBrowserSession(holder.session);
  }
  return Response.json({ checked, skipped: runs.length - checked, results });
}
