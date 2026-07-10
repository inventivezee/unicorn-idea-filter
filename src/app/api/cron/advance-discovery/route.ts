// Vercel cron: advances discovery runs browserlessly, every minute. Same
// fail-closed auth contract as advance-designs: 503 when CRON_SECRET is
// unset, 401 on mismatch, 200 {checked, results} when healthy.
import { advanceDiscoveryRun, sweepNotifications } from "@/lib/discovery/engine";
import { CRON_TIME_BUDGET_MS, discoveryConfigured } from "@/lib/discovery/config";
import { listActiveRuns } from "@/lib/db/discovery";
import { adminClient, cloudConfigured } from "@/lib/supabase/server";

export const maxDuration = 800; // Vercel Pro (GA limit; build fails on Hobby)

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
  } catch {
    // Sweep is best-effort — never blocks advancement.
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
  for (const run of runs) {
    if (Date.now() > invocationDeadline - 60_000) break;
    checked++;
    try {
      const result = await advanceDiscoveryRun(admin, run, invocationDeadline);
      results.push(result as unknown as Record<string, unknown>);
    } catch (err) {
      results.push({
        runId: run.id,
        status: "error",
        error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
      });
    }
  }
  return Response.json({ checked, skipped: runs.length - checked, results });
}
