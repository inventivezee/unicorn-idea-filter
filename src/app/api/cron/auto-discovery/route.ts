// Vercel cron: discovery autopilot, every 15 minutes. Starts a new batch
// for each enabled autopilot row, bounded by MAX_CONCURRENT_AUTOPILOT_RUNS
// running runs per owner (arrival must not outrun throughput — unbounded
// stacking would mass-fail runs by deadline instead of finishing them).
// Same fail-closed auth contract as the other crons.
import { DiscoveryCapError, startDiscoveryRun } from "@/lib/discovery/create";
import {
  MAX_CONCURRENT_AUTOPILOT_RUNS,
  discoveryConfigured,
} from "@/lib/discovery/config";
import { adminClient, cloudConfigured } from "@/lib/supabase/server";

export const maxDuration = 60;

interface AutopilotRow {
  owner_id: string;
  enabled: boolean;
  batch: number;
  guidelines: string;
  use_founder_background: boolean;
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return Response.json(
      { error: "CRON_SECRET is not configured on this deployment." },
      { status: 503 },
    );
  }
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${secret}`) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  if (!cloudConfigured()) {
    return Response.json({ error: "Cloud not configured." }, { status: 503 });
  }
  if (!discoveryConfigured()) {
    return Response.json({ started: [], disabled: true });
  }

  const admin = adminClient();
  const { data, error } = await admin
    .from("discovery_autopilot")
    .select("*")
    .eq("enabled", true);
  if (error) {
    // Migration 015 not applied — autopilot simply isn't on yet.
    return Response.json({ started: [], pending_migration: true });
  }

  const started: string[] = [];
  const skipped: Array<{ owner: string; reason: string }> = [];
  for (const row of (data ?? []) as AutopilotRow[]) {
    try {
      const { count } = await admin
        .from("discovery_runs")
        .select("id", { count: "exact", head: true })
        .eq("owner_id", row.owner_id)
        .eq("status", "running");
      if ((count ?? 0) >= MAX_CONCURRENT_AUTOPILOT_RUNS) {
        skipped.push({
          owner: row.owner_id,
          reason: `${count} runs already in flight (cap ${MAX_CONCURRENT_AUTOPILOT_RUNS})`,
        });
        continue;
      }
      const { runId } = await startDiscoveryRun(admin, row.owner_id, {
        guidelines: row.guidelines,
        useFounderBackground: row.use_founder_background,
        candidates: row.batch,
      });
      started.push(runId);
    } catch (err) {
      skipped.push({
        owner: row.owner_id,
        reason:
          err instanceof DiscoveryCapError
            ? "daily cap"
            : err instanceof Error
              ? err.message.slice(0, 120)
              : String(err),
      });
    }
  }
  return Response.json({ started, skipped });
}
