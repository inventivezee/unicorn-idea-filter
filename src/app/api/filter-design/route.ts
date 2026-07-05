// Starts a founder's custom-filter design as a background job — the
// three-model chain (GPT-5.5 Pro xhigh → Fable 5 max → GPT-5.5 Pro xhigh)
// takes 10-15+ minutes per GPT stage, so the POST claims a job row and lets
// the advance protocol submit stage 1; /api/filter-design/status advances it
// on every poll. Premium feature: requires a signed-in subscriber (or
// admin). Quota-free but capped per day.
//
// SPEND-SAFE ORDERING: the designing row (DB-unique per user) is claimed and
// the daily-cap log written BEFORE any provider call — a failure anywhere
// leaves at most a failed row, never an unmetered paid submission.
import {
  coFoundersFromBody,
  field,
  guardRequest,
  mapProviderError,
  readJsonBody,
} from "@/lib/ai/server";
import {
  CHAIN_ANTHROPIC_MODEL,
  CHAIN_OPENAI_MODEL,
  advanceDraftChain,
  capEscaped,
  initialChainState,
} from "@/lib/ai/design-chain";
import type { CustomFilterInputsPrompt } from "@/lib/ai/prompt";
import {
  DraftAccessError,
  createDraft,
  fetchOwnedDraft,
  updateDraft,
  type DraftRow,
} from "@/lib/db/drafts";
import {
  adminClient,
  cloudConfigured,
  requestTelemetry,
  resolveCaller,
} from "@/lib/supabase/server";

export const maxDuration = 300;

const MAX_DESIGNS_PER_DAY = 6;
// The chain stores these in the job payload; caps keep the payload bounded.
const MAX_CHAIN_BACKGROUND_CHARS = 20_000;
const MAX_CHAIN_COFOUNDER_CHARS = 8_000;

function num(v: unknown, lo: number, hi: number, fb: number): number {
  return typeof v === "number" && Number.isFinite(v)
    ? Math.min(hi, Math.max(lo, v))
    : fb;
}

export async function POST(request: Request) {
  const guard = guardRequest(request);
  if (guard) return guard;

  if (!cloudConfigured()) {
    return Response.json(
      {
        error:
          "Custom filter design needs the cloud deployment — it requires an account.",
      },
      { status: 503 },
    );
  }
  const caller = await resolveCaller();
  if (!caller.user) {
    return Response.json(
      {
        error: "Designing your own filter requires an account — sign in first.",
        signin: true,
      },
      { status: 401 },
    );
  }
  if (!caller.subscribed && !caller.isAdmin) {
    return Response.json(
      {
        error:
          "Designing your own filter is a subscriber feature — upgrade for $19/month.",
        upgrade: true,
      },
      { status: 402 },
    );
  }
  // The chain is fixed to specific models on both providers.
  const missingKeys = [
    process.env.OPENAI_API_KEY ? null : "OPENAI_API_KEY",
    process.env.ANTHROPIC_API_KEY ? null : "ANTHROPIC_API_KEY",
  ].filter(Boolean);
  if (missingKeys.length) {
    return Response.json(
      {
        error: `The design chain needs both providers configured — missing ${missingKeys.join(
          " and ",
        )} on this deployment.`,
      },
      { status: 503 },
    );
  }

  const body = await readJsonBody(request);
  if (!body) {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const rawInputs =
    body.inputs && typeof body.inputs === "object" && !Array.isArray(body.inputs)
      ? (body.inputs as Record<string, unknown>)
      : {};
  const inputs: CustomFilterInputsPrompt = {
    netProfitTarget: num(rawInputs.netProfitTarget, 1000, 1e9, 1_000_000),
    hoursPerDay: num(rawInputs.hoursPerDay, 1, 24, 8),
    yearsToBuild: num(rawInputs.yearsToBuild, 0.5, 50, 5),
    capitalAvailable: field(rawInputs.capitalAvailable, 200),
    maxTeamSize: field(rawInputs.maxTeamSize, 200),
    wantsToSell:
      rawInputs.wantsToSell === "yes" || rawInputs.wantsToSell === "no"
        ? (rawInputs.wantsToSell as string)
        : "maybe",
    otherQualities: field(rawInputs.otherQualities, 2000),
  };
  // Escape-aware caps: quote/backslash-heavy text serializes at 2-6x, and
  // the payload cap measures SERIALIZED size — cap what actually counts.
  const founderBackground = capEscaped(
    field(body.founderBackground, MAX_CHAIN_BACKGROUND_CHARS),
    MAX_CHAIN_BACKGROUND_CHARS,
  );
  const coFounders = coFoundersFromBody(body.coFounders).map((c) => ({
    name: c.name,
    background: capEscaped(c.background, MAX_CHAIN_COFOUNDER_CHARS),
  }));
  inputs.otherQualities = capEscaped(inputs.otherQualities, 4_000);
  const existingId = field(body.existingId, 64);
  const existingVersion = num(body.existingVersion, 1, 10_000, 0);
  const draftId = field(body.draftId, 64);

  const admin = adminClient();
  const actor = {
    userId: caller.user.id,
    anonKey: null,
    isAdmin: caller.isAdmin,
  };

  try {
    // Daily cap — each run is two GPT-5.5 Pro xhigh calls plus a Fable 5 max
    // call, the most expensive thing the app does. (The one-design-at-a-time
    // rule is enforced by the database's partial unique index, not a check.)
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { count, error: countError } = await admin
      .from("submission_logs")
      .select("id", { count: "exact", head: true })
      .eq("user_id", caller.user.id)
      .eq("action", "filter_design")
      .gte("created_at", since);
    if (countError) {
      // Never let a metering failure default to "0 used".
      return Response.json(
        { error: "Couldn't verify your design limit — try again shortly." },
        { status: 503 },
      );
    }
    if ((count ?? 0) >= MAX_DESIGNS_PER_DAY) {
      return Response.json(
        {
          error: `Design limit reached (${MAX_DESIGNS_PER_DAY} per day) — the chain is expensive to run. Try again tomorrow.`,
        },
        { status: 429 },
      );
    }

    // Meter FIRST — a failure anywhere later costs the user one cap slot at
    // worst, but a provider run can never happen unmetered.
    const { error: logError } = await admin.from("submission_logs").insert({
      user_id: caller.user.id,
      anon_key: null,
      action: "filter_design",
      ...requestTelemetry(request),
      provider: "openai",
      model: `${CHAIN_OPENAI_MODEL} → ${CHAIN_ANTHROPIC_MODEL} → ${CHAIN_OPENAI_MODEL}`,
    });
    if (logError) {
      return Response.json(
        { error: "Couldn't record this design run — try again shortly." },
        { status: 503 },
      );
    }

    const payload: Record<string, unknown> = {
      inputs,
      founderBackground,
      coFounders,
      ...(existingId ? { existingId, existingVersion } : {}),
      chain: initialChainState(),
    };

    // Claim the designing row — the partial unique index makes a fresh
    // insert atomic, and the reuse path flips status ATOMICALLY from the
    // exact status it read (a concurrent POST reusing the same row loses
    // with 409 instead of resetting a claimed chain).
    let draft: DraftRow | null = null;
    if (draftId) {
      try {
        const existing = await fetchOwnedDraft(admin, actor, draftId);
        if (existing.kind === "filter" && existing.status !== "designing") {
          draft = await updateDraft(
            admin,
            actor,
            existing.id,
            { payload, status: "designing" },
            existing.status,
          );
        }
      } catch (err) {
        if (err instanceof DraftAccessError && err.status === 409) throw err;
        // Stale/foreign draft id — fall through to a fresh row.
      }
    }
    if (!draft) {
      draft = await createDraft(admin, actor, "filter", payload, "designing");
    }

    // Kick stage 1 now (claim + submit); if this fails transiently the
    // status poll route retries the same advance.
    try {
      draft = await advanceDraftChain(admin, draft);
    } catch {
      // The row is claimed and metered — polling will pick it up.
    }

    return Response.json({ draftId: draft.id, status: draft.status });
  } catch (err) {
    if (err instanceof DraftAccessError) {
      const payload: Record<string, unknown> = { error: err.message };
      if (err.status === 409) {
        // Point the client at the already-running design so it can attach.
        try {
          const mine = await (
            await import("@/lib/db/drafts")
          ).listOwnedDrafts(admin, actor, "filter");
          const running = mine.find((d) => d.status === "designing");
          if (running) payload.draftId = running.id;
        } catch {
          // Best-effort enrichment only.
        }
      }
      return Response.json(payload, { status: err.status });
    }
    return mapProviderError(err, CHAIN_OPENAI_MODEL);
  }
}
