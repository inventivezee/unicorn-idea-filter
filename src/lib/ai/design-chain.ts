// The three-model filter-design chain, run as a background job because a
// single pass can take 10-15+ minutes — far past any serverless window:
//
//   stage 1  GPT-5.5 Pro (reasoning effort xhigh) designs the instrument
//            — OpenAI Responses API background mode, polled by id
//   stage 2  Claude Fable 5 (output_config.effort "max") adversarially
//            reviews and improves it — Anthropic Message Batches API
//            (the only Anthropic async surface; no held connection)
//   stage 3  GPT-5.5 Pro (xhigh) reconciles both versions into the final
//            instrument — OpenAI background mode again
//
// SPEND-SAFETY PROTOCOL: state lives in a `drafts` row and every paid
// provider submission is preceded by a compare-and-swap "claim" that
// increments that stage's persisted submit counter. Concurrent polls both
// see work to do, but only the CAS winner submits — the loser spends
// nothing. A submission whose jobId write later fails is already counted,
// so MAX_SUBMITS_PER_STAGE bounds worst-case spend even through crashes.
// Phases: "pending_submit" (claim needed) → "in_flight" (jobId polled).
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  FILTER_DESIGN_SYSTEM_PROMPT,
  FILTER_FINAL_REVIEW_SYSTEM_PROMPT,
  FILTER_REVIEW_SYSTEM_PROMPT,
  buildFilterDesignPrompt,
  buildFilterFinalPrompt,
  buildFilterReviewPrompt,
  type CustomFilterInputsPrompt,
} from "./prompt";
import { FILTER_DESIGN_SCHEMA } from "./schema";
import { casUpdateDraft, type DraftRow } from "@/lib/db/drafts";
import { designFailedEmail, designReadyEmail, sendEmail } from "@/lib/email";
import { normalizeCustomFilterSpec } from "@/lib/types";

export const CHAIN_OPENAI_MODEL = "gpt-5.5-pro";
export const CHAIN_ANTHROPIC_MODEL = "claude-fable-5";
// Refusal fallback for stage 2 — batches reject the server-side `fallbacks`
// param, so a Fable refusal is retried on Opus manually.
const CHAIN_ANTHROPIC_FALLBACK = "claude-opus-4-8";
const OPENAI_MAX_OUTPUT_TOKENS = 64_000;
const ANTHROPIC_MAX_TOKENS = 64_000;
// Per-stage submission budget (first submit + retries for expiry/errors).
const MAX_SUBMITS_PER_STAGE = 3;
// A raw stage design is ~3-15KB of JSON; anything bigger is malformed and
// would fail normalization anyway — truncate so chain state always fits the
// draft-payload cap.
const MAX_DESIGN_CHARS = 40_000;
// Hard deadlines: a chain older than this (or a single stage stuck this
// long) fails rather than occupying the user's one-design slot forever.
const CHAIN_DEADLINE_MS = 24 * 60 * 60 * 1000;
const STAGE_DEADLINE_MS = 6 * 60 * 60 * 1000;
// in_flight with a null jobId means a claim's submission (or its jobId
// write) died mid-way — after this grace period the next poll re-claims.
const CLAIM_GRACE_MS = 3 * 60 * 1000;

export type ChainStage = 1 | 2 | 3;
export type ChainPhase = "pending_submit" | "in_flight";

export interface ChainState {
  stage: ChainStage;
  phase: ChainPhase;
  /** Provider job id (OpenAI response id / Anthropic batch id) once submitted. */
  jobId: string | null;
  /** Which model the next/current stage-2 batch runs on (refusal fallback). */
  stage2Model?: string;
  /** Raw JSON text of each completed stage's design (truncated). */
  stage1Design?: string;
  stage2Design?: string;
  finalDesign?: string;
  /** Persisted per-stage submit counters — bumped at CLAIM time. */
  submits: Record<string, number>;
  startedAt: string;
  stageStartedAt: string;
  error?: string;
}

export interface ChainInputs {
  inputs: CustomFilterInputsPrompt;
  founderBackground: string;
  coFounders: { name: string; background: string }[];
}

export class ChainError extends Error {}

function openaiClient(): OpenAI {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}
function anthropicClient(): Anthropic {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

/** The initial (nothing-submitted-yet) chain state. */
export function initialChainState(): ChainState {
  const now = new Date().toISOString();
  return {
    stage: 1,
    phase: "pending_submit",
    jobId: null,
    submits: {},
    startedAt: now,
    stageStartedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Provider submissions — called ONLY by the CAS winner of a claim.
// ---------------------------------------------------------------------------

async function submitOpenAI(
  stage: 1 | 3,
  state: ChainState,
  chain: ChainInputs,
): Promise<string> {
  const prompt =
    stage === 1
      ? buildFilterDesignPrompt(
          chain.inputs,
          chain.founderBackground,
          chain.coFounders,
        )
      : buildFilterFinalPrompt(
          chain.inputs,
          chain.founderBackground,
          chain.coFounders,
          state.stage1Design ?? "",
          state.stage2Design ?? "",
        );
  const response = await openaiClient().responses.create({
    model: CHAIN_OPENAI_MODEL,
    instructions:
      stage === 1
        ? FILTER_DESIGN_SYSTEM_PROMPT
        : FILTER_FINAL_REVIEW_SYSTEM_PROMPT,
    input: prompt,
    reasoning: { effort: "xhigh" },
    background: true,
    max_output_tokens: OPENAI_MAX_OUTPUT_TOKENS,
    text: {
      format: {
        type: "json_schema",
        name: "filter_design",
        strict: true,
        schema: FILTER_DESIGN_SCHEMA as unknown as Record<string, unknown>,
      },
    },
  });
  return response.id;
}

async function submitAnthropic(
  state: ChainState,
  chain: ChainInputs,
  model: string,
): Promise<string> {
  const batch = await anthropicClient().messages.batches.create({
    requests: [
      {
        custom_id: "filter-review",
        params: {
          model,
          max_tokens: ANTHROPIC_MAX_TOKENS,
          system: FILTER_REVIEW_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: buildFilterReviewPrompt(
                chain.inputs,
                chain.founderBackground,
                chain.coFounders,
                state.stage1Design ?? "",
              ),
            },
          ],
          // Fable 5: thinking is always on; effort "max" per the user's spec.
          output_config: {
            effort: "max",
            format: {
              type: "json_schema",
              schema: FILTER_DESIGN_SCHEMA as unknown as Record<
                string,
                unknown
              >,
            },
          },
        } as unknown as Anthropic.Messages.MessageCreateParamsNonStreaming,
      },
    ],
  });
  return batch.id;
}

// ---------------------------------------------------------------------------
// Provider polling — idempotent reads, safe to repeat from any caller.
// ---------------------------------------------------------------------------

type PollOutcome =
  | { kind: "pending" }
  | { kind: "result"; text: string }
  | { kind: "refused" }
  /** Job vanished / expired / terminally failed — needs a fresh submission. */
  | { kind: "resubmit"; detail: string };

function isNotFound(err: unknown): boolean {
  return (
    (err instanceof OpenAI.APIError && err.status === 404) ||
    (err instanceof Anthropic.APIError && err.status === 404)
  );
}

async function pollOpenAI(jobId: string): Promise<PollOutcome> {
  let response: OpenAI.Responses.Response;
  try {
    response = await openaiClient().responses.retrieve(jobId);
  } catch (err) {
    // Background responses are only retained ~10 minutes after completion.
    if (isNotFound(err)) return { kind: "resubmit", detail: "result expired" };
    throw err; // transient — caller reports still-designing, next poll retries
  }
  if (response.status === "queued" || response.status === "in_progress") {
    return { kind: "pending" };
  }
  if (response.status === "completed") {
    const text = response.output_text ?? "";
    if (text.trim()) return { kind: "result", text };
    return { kind: "resubmit", detail: "empty output" };
  }
  return {
    kind: "resubmit",
    detail:
      response.status === "incomplete"
        ? (response.incomplete_details?.reason ?? "incomplete")
        : (response.error?.message ?? response.status ?? "unknown"),
  };
}

async function pollAnthropic(
  jobId: string,
  currentModel: string,
): Promise<PollOutcome | { kind: "fallback" }> {
  let batch: Anthropic.Messages.Batches.MessageBatch;
  try {
    batch = await anthropicClient().messages.batches.retrieve(jobId);
  } catch (err) {
    if (isNotFound(err)) return { kind: "resubmit", detail: "batch missing" };
    throw err;
  }
  if (batch.processing_status !== "ended") return { kind: "pending" };
  try {
    for await (const item of await anthropicClient().messages.batches.results(
      batch.id,
    )) {
      if (item.custom_id !== "filter-review") continue;
      if (item.result.type === "succeeded") {
        const message = item.result.message;
        if (message.stop_reason === "refusal") {
          // Batches reject the fallbacks param — retry on Opus manually.
          return currentModel === CHAIN_ANTHROPIC_FALLBACK
            ? { kind: "refused" }
            : { kind: "fallback" };
        }
        const text = message.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("");
        if (text.trim()) return { kind: "result", text };
        return { kind: "resubmit", detail: "empty review output" };
      }
      if (item.result.type === "errored") {
        return {
          kind: "resubmit",
          detail: JSON.stringify(item.result.error ?? {}).slice(0, 300),
        };
      }
      return { kind: "resubmit", detail: item.result.type }; // expired/canceled
    }
  } catch (err) {
    if (isNotFound(err)) return { kind: "resubmit", detail: "results missing" };
    throw err;
  }
  return { kind: "resubmit", detail: "batch returned no result" };
}

// ---------------------------------------------------------------------------
// The advance step — one poll OR one claimed submission per call.
// ---------------------------------------------------------------------------

/** Coerce a stored draft payload's chain state; null when malformed. */
export function chainStateFrom(value: unknown): ChainState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const stage = v.stage;
  if (stage !== 1 && stage !== 2 && stage !== 3) return null;
  return {
    stage,
    phase: v.phase === "in_flight" ? "in_flight" : "pending_submit",
    jobId: typeof v.jobId === "string" ? v.jobId : null,
    ...(typeof v.stage2Model === "string" ? { stage2Model: v.stage2Model } : {}),
    ...(typeof v.stage1Design === "string"
      ? { stage1Design: v.stage1Design }
      : {}),
    ...(typeof v.stage2Design === "string"
      ? { stage2Design: v.stage2Design }
      : {}),
    ...(typeof v.finalDesign === "string"
      ? { finalDesign: v.finalDesign }
      : {}),
    submits:
      v.submits && typeof v.submits === "object" && !Array.isArray(v.submits)
        ? Object.fromEntries(
            Object.entries(v.submits as Record<string, unknown>).filter(
              (e): e is [string, number] => typeof e[1] === "number",
            ),
          )
        : {},
    startedAt:
      typeof v.startedAt === "string" ? v.startedAt : new Date().toISOString(),
    stageStartedAt:
      typeof v.stageStartedAt === "string"
        ? v.stageStartedAt
        : new Date().toISOString(),
    ...(typeof v.error === "string" ? { error: v.error } : {}),
  };
}

export function chainInputsFrom(
  payload: Record<string, unknown>,
): ChainInputs | null {
  const inputs = payload.inputs as CustomFilterInputsPrompt | undefined;
  if (!inputs || typeof inputs !== "object") return null;
  return {
    inputs,
    founderBackground:
      typeof payload.founderBackground === "string"
        ? payload.founderBackground
        : "",
    coFounders: Array.isArray(payload.coFounders)
      ? (payload.coFounders as ChainInputs["coFounders"])
      : [],
  };
}

/** Cap a string by its JSON-SERIALIZED length — quotes/backslashes/control
 *  chars escape to 2-6 bytes, so raw-char caps under-count exactly the
 *  payloads that would blow the draft cap. */
export function capEscaped(text: string, max: number): string {
  let t = text;
  while (t && JSON.stringify(t).length - 2 > max) {
    // Overshoot ratio tells us how much to keep; minus a safety margin.
    const ratio = max / (JSON.stringify(t).length - 2);
    const keep = Math.floor(t.length * ratio * 0.98);
    t = t.slice(0, Math.max(0, Math.min(keep, t.length - 1)));
  }
  return t;
}

function truncateDesign(text: string): string {
  return capEscaped(text, MAX_DESIGN_CHARS);
}

/** What the next claimed submission for this state would run. */
function submitTarget(state: ChainState): {
  stage: ChainStage;
  model: string;
} {
  if (state.stage === 2) {
    return { stage: 2, model: state.stage2Model ?? CHAIN_ANTHROPIC_MODEL };
  }
  return { stage: state.stage, model: CHAIN_OPENAI_MODEL };
}

/**
 * Email the design's owner about a terminal transition. Called ONLY by the
 * CAS winner of that transition, so each design sends at most one "ready"
 * and one "failed" mail. Best-effort: a mail failure never fails the chain.
 */
async function notifyOwner(
  admin: SupabaseClient,
  draft: DraftRow,
  mail: { subject: string; html: string },
): Promise<void> {
  if (!draft.owner_id) return;
  try {
    const { data } = await admin
      .from("profiles")
      .select("email")
      .eq("id", draft.owner_id)
      .maybeSingle<{ email: string | null }>();
    if (data?.email) {
      await sendEmail({ to: data.email, ...mail });
    }
  } catch (err) {
    console.error(
      "design notification failed",
      err instanceof Error ? err.message : err,
    );
  }
}

async function failDraft(
  admin: SupabaseClient,
  draft: DraftRow,
  state: ChainState,
  message: string,
): Promise<DraftRow> {
  try {
    const updated = await casUpdateDraft(admin, draft.id, draft.rev, {
      payload: { ...draft.payload, chain: { ...state, error: message } },
      status: "failed",
    });
    if (updated) await notifyOwner(admin, draft, designFailedEmail(message));
    return updated ?? draft;
  } catch {
    // The terminal transition must ALWAYS land — if the full payload trips
    // the size cap, retry with the bulky design texts stripped (they're
    // useless on a failed job anyway). A wedged "designing" row would block
    // the user's one-design slot forever.
    const lean: ChainState = {
      ...state,
      error: message,
      stage1Design: undefined,
      stage2Design: undefined,
      finalDesign: undefined,
    };
    const updated = await casUpdateDraft(admin, draft.id, draft.rev, {
      payload: { ...draft.payload, chain: lean },
      status: "failed",
    });
    if (updated) await notifyOwner(admin, draft, designFailedEmail(message));
    return updated ?? draft;
  }
}

/**
 * Advance a designing draft's chain by one step. Every paid submission is
 * claimed first (CAS + persisted submit counter), so concurrent callers
 * cannot double-spend. Returns the freshest draft row it knows.
 */
export async function advanceDraftChain(
  admin: SupabaseClient,
  draft: DraftRow,
): Promise<DraftRow> {
  const payload = draft.payload as Record<string, unknown>;
  const state = chainStateFrom(payload.chain);
  const chainInputs = chainInputsFrom(payload);
  if (!state || !chainInputs) {
    const updated = await casUpdateDraft(admin, draft.id, draft.rev, {
      payload: {
        ...payload,
        chain: {
          ...(state ?? initialChainState()),
          error: "The design state was corrupted — start a new design.",
        },
      },
      status: "failed",
    });
    return updated ?? draft;
  }

  const now = Date.now();
  if (
    now - Date.parse(state.startedAt) > CHAIN_DEADLINE_MS ||
    now - Date.parse(state.stageStartedAt) > STAGE_DEADLINE_MS
  ) {
    void cancelChain(state); // stop billing the stuck provider job
    return failDraft(
      admin,
      draft,
      state,
      "The design ran out of time — start it again.",
    );
  }

  // -------------------------------------------------------------------
  // Phase: needs a submission → claim it, then (as the winner) submit.
  // -------------------------------------------------------------------
  if (state.phase === "pending_submit") {
    const target = submitTarget(state);
    const key = `s${target.stage}`;
    const used = state.submits[key] ?? 0;
    if (used >= MAX_SUBMITS_PER_STAGE) {
      return failDraft(
        admin,
        draft,
        state,
        `Stage ${target.stage} failed after ${MAX_SUBMITS_PER_STAGE} attempts — try designing again.`,
      );
    }
    const claimed: ChainState = {
      ...state,
      phase: "in_flight",
      jobId: null,
      submits: { ...state.submits, [key]: used + 1 },
      stageStartedAt: new Date().toISOString(),
    };
    const claimedRow = await casUpdateDraft(admin, draft.id, draft.rev, {
      payload: { ...payload, chain: claimed },
    });
    if (!claimedRow) return draft; // another poll claimed it — spend nothing

    let jobId: string;
    try {
      jobId =
        target.stage === 2
          ? await submitAnthropic(claimed, chainInputs, target.model)
          : await submitOpenAI(target.stage as 1 | 3, claimed, chainInputs);
    } catch (err) {
      // Submission failed — release the claim (attempt already counted) so
      // the next poll can retry within the budget.
      const released = await casUpdateDraft(admin, claimedRow.id, claimedRow.rev, {
        payload: {
          ...payload,
          chain: { ...claimed, phase: "pending_submit" },
        },
      });
      if (err instanceof OpenAI.APIError || err instanceof Anthropic.APIError) {
        return released ?? claimedRow;
      }
      throw err;
    }
    const withJob = await casUpdateDraft(admin, claimedRow.id, claimedRow.rev, {
      payload: {
        ...payload,
        chain: { ...claimed, jobId },
      },
    });
    // If this write failed, the claim row stays in_flight/jobId-null and the
    // grace-period re-claim path recovers it — already budget-counted.
    return withJob ?? claimedRow;
  }

  // -------------------------------------------------------------------
  // Phase: in flight. jobId null = a claim died mid-submission — re-claim
  // after a grace period (the counted attempt covers the possible orphan).
  // -------------------------------------------------------------------
  if (!state.jobId) {
    if (now - Date.parse(state.stageStartedAt) < CLAIM_GRACE_MS) return draft;
    const updated = await casUpdateDraft(admin, draft.id, draft.rev, {
      payload: {
        ...payload,
        chain: { ...state, phase: "pending_submit" },
      },
    });
    return updated ?? draft;
  }

  let outcome: PollOutcome | { kind: "fallback" };
  try {
    outcome =
      state.stage === 2
        ? await pollAnthropic(state.jobId, state.stage2Model ?? CHAIN_ANTHROPIC_MODEL)
        : await pollOpenAI(state.jobId);
  } catch {
    return draft; // transient — next poll retries the same read
  }

  if (outcome.kind === "pending") return draft;

  if (outcome.kind === "refused") {
    return failDraft(
      admin,
      draft,
      state,
      "The review model declined this input. Adjust the goals text and try again.",
    );
  }

  let next: ChainState;
  if (outcome.kind === "fallback") {
    next = {
      ...state,
      phase: "pending_submit",
      jobId: null,
      stage2Model: CHAIN_ANTHROPIC_FALLBACK,
    };
  } else if (outcome.kind === "resubmit") {
    next = { ...state, phase: "pending_submit", jobId: null };
  } else {
    // A stage completed with output.
    const text = truncateDesign(outcome.text);
    if (state.stage === 1) {
      next = {
        ...state,
        stage: 2,
        phase: "pending_submit",
        jobId: null,
        stage1Design: text,
        stage2Model: CHAIN_ANTHROPIC_MODEL,
        stageStartedAt: new Date().toISOString(),
      };
    } else if (state.stage === 2) {
      next = {
        ...state,
        stage: 3,
        phase: "pending_submit",
        jobId: null,
        stage2Design: text,
        stageStartedAt: new Date().toISOString(),
      };
    } else {
      // Final stage — normalize and finish the job.
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
      const existingId =
        typeof payload.existingId === "string" ? payload.existingId : "";
      const existingVersion =
        typeof payload.existingVersion === "number"
          ? payload.existingVersion
          : 0;
      const spec = parsed
        ? normalizeCustomFilterSpec({
            ...parsed,
            id: existingId || crypto.randomUUID(),
            version: existingVersion > 0 ? existingVersion + 1 : 1,
            inputs: chainInputs.inputs,
            createdAt: new Date().toISOString(),
          })
        : null;
      if (!spec) {
        // Unusable final output — retry stage 3 within the budget.
        next = { ...state, phase: "pending_submit", jobId: null };
        const updated = await casUpdateDraft(admin, draft.id, draft.rev, {
          payload: { ...payload, chain: next },
        });
        return updated ?? draft;
      }
      const done: ChainState = { ...state, finalDesign: text, jobId: null };
      const updated = await casUpdateDraft(admin, draft.id, draft.rev, {
        payload: { ...payload, chain: done, resultSpec: spec },
        status: "ready",
      });
      if (updated) await notifyOwner(admin, draft, designReadyEmail(spec.name));
      return updated ?? draft;
    }
  }

  const updated = await casUpdateDraft(admin, draft.id, draft.rev, {
    payload: { ...payload, chain: next },
  });
  return updated ?? draft;
}

/**
 * Best-effort cancellation of whatever provider job the chain has in flight —
 * called when a designing draft is deleted so an abandoned xhigh/max run
 * stops billing. Never throws.
 */
export async function cancelChain(state: ChainState | null): Promise<void> {
  if (!state?.jobId || state.finalDesign) return;
  try {
    if (state.stage === 2) {
      await anthropicClient().messages.batches.cancel(state.jobId);
    } else {
      await openaiClient().responses.cancel(state.jobId);
    }
  } catch {
    // The job may already be terminal — nothing to do.
  }
}
