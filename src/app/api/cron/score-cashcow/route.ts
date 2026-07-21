// Vercel cron: autonomous Cash Cow scoring, every minute. Sweeps discovery
// ideas that don't yet carry a Cash Cow verdict and scores each ONCE
// (Opus 4.8 / Sol at max, web search available), writing ideas.cashcow.
// Every scoring sits behind an atomic claim (claim_cashcow_job) so
// overlapping invocations never double-bill. No reframe — score, not filter.
// Same fail-closed auth contract as the other crons.
import { randomUUID } from "node:crypto";
import {
  claimCashCowJob,
  finishCashCowJob,
  isTransientProviderError,
  listCashCowCandidates,
  releaseCashCowJobTransient,
} from "@/lib/db/cashcowJobs";
import { scoreCashCow } from "@/lib/cashcow/score";
import { adminClient, cloudConfigured } from "@/lib/supabase/server";

export const maxDuration = 300;

const BATCH = 12; // candidates fetched per invocation
const CONCURRENCY = 4; // parallel scoring calls
const TIME_BUDGET_MS = 240_000; // leave headroom under maxDuration

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
          console.error(`[cashcow] scoring ${idea.id} failed:`, msg);
          if (isTransientProviderError(msg)) {
            // Provider outage (e.g. OpenAI 429 quota) — refund the attempt
            // and retry on a later tick; never let it burn the cap.
            await releaseCashCowJobTransient(admin, idea.id);
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
