// Vercel cron: autonomous Cash Cow scoring, every minute. Sweeps discovery
// ideas that don't yet carry a Cash Cow verdict and scores each ONCE
// (Opus 4.8 / Sol at max, web search available), writing ideas.cashcow.
// Every scoring sits behind an atomic claim (claim_cashcow_job) so
// overlapping invocations never double-bill. No reframe — score, not filter.
// Same fail-closed auth contract as the other crons.
import { randomUUID } from "node:crypto";
import {
  claimCashCowJob,
  classifyProviderError,
  finishCashCowJob,
  listCashCowCandidates,
  releaseCashCowJobTransient,
} from "@/lib/db/cashcowJobs";
import { scoreCashCow } from "@/lib/cashcow/score";
import { adminClient, cloudConfigured } from "@/lib/supabase/server";

// Full Pro window: a single Opus/Sol max-effort + web-search scoring
// call can exceed 5 min — at 300s the function was killed mid-call and the
// verdict never landed (job stuck in_flight, retried forever).
export const maxDuration = 1800; // 30-min beta window — search-heavy max-effort calls need it

// Kill switch. Autonomous scoring bills ~$0.60-0.95 per idea and drains a
// backlog unattended, so it stays OFF unless the deployment opts in.
const enabled = () => /^(1|true|on)$/i.test(process.env.CASHCOW_AUTOSCORE ?? "");

const BATCH = 12; // candidates fetched per invocation
const CONCURRENCY = 4; // parallel scoring calls
const TIME_BUDGET_MS = 1_500_000; // leave headroom under maxDuration

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
  if (!enabled()) {
    // Frozen on purpose — nothing is claimed, so nothing can be billed.
    return Response.json({ paused: true, scored: 0 });
  }

  const admin = adminClient();
  const candidates = await listCashCowCandidates(admin, BATCH);
  if (candidates.length === 0) {
    return Response.json({ scored: 0, remaining: 0 });
  }

  const deadline = Date.now() + TIME_BUDGET_MS;
  const queue = [...candidates];
  let scored = 0;
  let failed = 0;

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (;;) {
        const idea = queue.shift();
        if (!idea) return;
        if (Date.now() > deadline - 60_000) return;
        const token = randomUUID();
        // Claim BEFORE any provider call — the CAS is the double-bill guard.
        if (!(await claimCashCowJob(admin, idea.id, token))) continue;
        try {
          await scoreCashCow(admin, idea);
          await finishCashCowJob(admin, idea.id, "done");
          scored++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const failure = classifyProviderError(msg);
          console.error(
            `[cashcow] scoring ${idea.id} failed (${failure.kind}):`,
            msg,
          );
          if (failure.transient) {
            // Provider-side problem (quota, outage, disabled key) — refund
            // the attempt and hold the idea out for the class's backoff.
            // Never let someone else's outage burn this idea's cap.
            await releaseCashCowJobTransient(
              admin,
              idea.id,
              msg,
              failure.backoffSeconds,
            );
          } else {
            // A real, repeatable failure — count it toward the attempt cap.
            await finishCashCowJob(admin, idea.id, "failed", msg);
            failed++;
          }
        }
      }
    }),
  );

  return Response.json({ scored, failed });
}
