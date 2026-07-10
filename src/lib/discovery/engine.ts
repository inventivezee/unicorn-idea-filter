// Discovery engine orchestrator. Advances one RUN by advancing its TASKS
// through: researching → generated → scoring → (reframing → rescoring) →
// done/failed, one bounded STEP per claim.
//
// Spend-safety protocol (invariant #1, per the red-teamed design):
// - Every paid step bumps the task's turn counter INSIDE the claim CAS,
//   BEFORE any provider call. A crash wastes at most the step in flight;
//   retries resume from persisted loop state, never re-run a phase.
// - A claim carries {token, heartbeat_at}; other workers steal it only
//   after CLAIM_LEASE_MS of silence. Within a chunk, rev-chaining (each
//   CAS returns the row we keep advancing) makes us the only writer.
// - Browserbase minutes are charged pessimistically (full session timeout)
//   into the run budget BEFORE the session is created; sessions are
//   per-chunk and released in `finally` (no keepAlive → a dead worker's
//   session dies with its CDP connection).
// - Publishing is ONE atomic insertIdea at candidate-terminal with a
//   DETERMINISTIC id, so crash-retries converge on a single row.
import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ANALYSIS_SCHEMA } from "@/lib/ai/schema";
import {
  normalizeAnalysis,
  type RawAnalysis,
} from "@/lib/ai/analysis";
import { DEFAULT_WEIGHTS } from "@/lib/criteria";
import { decision } from "@/lib/engine";
import { insertIdea } from "@/lib/db/ideas";
import { sendEmail } from "@/lib/email";
import {
  bumpRunBudget,
  casUpdateRun,
  casUpdateTask,
  claimAvailable,
  fetchRun,
  fetchTasks,
  listUnnotifiedTerminalRuns,
  logEvent,
  type DiscoveryRunRow,
  type DiscoveryTaskRow,
  type TaskStatus,
} from "@/lib/db/discovery";
import type {
  AnalyzeResponse,
  CriterionId,
  GateId,
  GateValue,
  Idea,
} from "@/lib/types";
import {
  BB_RUN_MINUTES_CAP,
  BB_SESSION_TIMEOUT_SECONDS,
  MAX_REFRAME_LOOPS,
  SCORER_ANTHROPIC,
  SCORER_OPENAI,
  scoringPanel,
  scoringVariant,
  WORST_TURN_MS,
  PASSING_DECISIONS,
  PHASE_DEADLINE_MS,
  RUN_TOTAL_TURN_CAP,
  TURN_CAPS,
  pickReframer,
  pickRescorer,
  roundForIdx,
  type DiscoveryModel,
  type TurnPhase,
} from "./config";
import {
  closeTaskPage,
  createBrowserSession,
  createTaskPage,
  releaseBrowserSession,
  type BrowserHandle,
  type BrowserSession,
} from "./browserbase";
import {
  initialLoopState,
  openaiSynthesisPoll,
  openaiSynthesisSubmit,
  openaiSynthesisSync,
  plainTextCall,
  runResearchTurn,
  runSynthesisSync,
  type LoopState,
} from "./toolloop";
import {
  IDEA_GEN_SCHEMA,
  buildCritiqueSystem,
  buildDiscoveryResearchPrompt,
  buildScoringFeedbackPrompt,
  buildScoringFeedbackSystem,
  buildDiscoveryResearchSystem,
  buildGenerationSynthesisPrompt,
  buildGenerationSynthesisSystem,
  buildReframeResearchSystem,
  buildReframeSynthesisSystem,
  buildScoringResearchPrompt,
  buildScoringResearchSystem,
  buildScoringSynthesisPrompt,
  buildScoringSynthesisSystem,
  normalizeGeneratedIdea,
  type GeneratedIdea,
} from "./prompts";

/** Deterministic uuid from a seed (stable across crash-retries). */
export function deterministicUuid(seed: string): string {
  const h = createHash("sha256").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

interface PhaseState {
  loop?: LoopState;
  idea?: GeneratedIdea;
  brief?: string;
  memo?: string;
  /** Raw phase transcript — carried into synthesis so the brief/memo
   *  compression never throws away paid-for evidence. */
  researchLog?: string;
  /** Red-team pass over the brief (generation phase only). */
  critique?: string;
  synthJobId?: string;
  verdictSummary?: string;
  /** Dual-model scoring: Fable's draft, then Sol's review memo, then the
   *  final verdict. */
  verdictDraft?: AnalyzeResponse;
  feedback?: string;
  verdict?: AnalyzeResponse;
  reframeAttempt?: number;
  reframeHistory?: Array<{ name: string; summary: string }>;
  forcedWrapup?: boolean;
  founderBackground?: string;
  round?: number;
}

type Step =
  | { kind: "init" }
  | { kind: "research_turn"; phase: TurnPhase }
  | { kind: "synth_submit"; phase: TurnPhase }
  | { kind: "synth_poll"; phase: TurnPhase }
  | { kind: "critique"; phase: TurnPhase }
  | { kind: "synth_sync"; phase: TurnPhase }
  | { kind: "score_sync"; phase: TurnPhase }
  | { kind: "decide" }
  | { kind: "begin_scoring" };

/** Worst-case wall-clock per step kind — the pre-claim gate. Every value
 *  MUST be strictly below CRON_TIME_BUDGET_MS or the step can never be
 *  claimed (unit-tested). */
export function worstCaseMs(step: { kind: Step["kind"] }, provider: string): number {
  switch (step.kind) {
    case "research_turn":
      return provider === "openrouter"
        ? WORST_TURN_MS.openrouter
        : WORST_TURN_MS.premium;
    case "critique":
    case "synth_sync":
    case "score_sync":
      return WORST_TURN_MS.synthesis;
    case "synth_submit":
      return 30_000;
    case "synth_poll":
      return 20_000;
    default:
      return 10_000;
  }
}

function turnKeyFor(status: TaskStatus): TurnPhase {
  if (status === "researching") return "research";
  if (status === "scoring") return "score";
  if (status === "reframing") return "reframe";
  return "rescore";
}

/** Raw transcript of a research loop — assistant reasoning, tool calls,
 *  and tool results — so downstream synthesis can recover specifics that
 *  the brief/memo compressed away. Newest 400k chars win. */
function transcriptFromLoop(loop: LoopState | undefined): string {
  if (!loop) return "";
  const parts: string[] = [];
  if (loop.kind === "anthropic" || loop.kind === "openrouter") {
    for (const m of loop.messages) {
      const msg = m as {
        role?: string;
        content?: unknown;
        tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
      };
      if (msg.role === "assistant") {
        if (typeof msg.content === "string") parts.push(`AGENT: ${msg.content}`);
        else if (Array.isArray(msg.content)) {
          for (const block of msg.content as Array<Record<string, unknown>>) {
            if (block.type === "text") parts.push(`AGENT: ${block.text}`);
            if (block.type === "tool_use") {
              parts.push(`TOOL CALL ${block.name}(${JSON.stringify(block.input).slice(0, 300)})`);
            }
          }
        }
        for (const tc of msg.tool_calls ?? []) {
          parts.push(
            `TOOL CALL ${tc.function?.name}(${(tc.function?.arguments ?? "").slice(0, 300)})`,
          );
        }
      } else if (msg.role === "tool" && typeof msg.content === "string") {
        parts.push(`RESULT: ${msg.content}`);
      } else if (msg.role === "user" && Array.isArray(msg.content)) {
        for (const block of msg.content as Array<Record<string, unknown>>) {
          if (block.type === "tool_result") {
            const c = block.content;
            if (typeof c === "string") parts.push(`RESULT: ${c}`);
            else if (Array.isArray(c)) {
              for (const cb of c as Array<Record<string, unknown>>) {
                if (cb.type === "text") parts.push(`RESULT: ${cb.text}`);
              }
            }
          }
        }
      }
    }
  } else if (loop.lastText) {
    parts.push(loop.lastText);
  }
  const full = parts.join("\n\n");
  return full.slice(-400_000);
}

/** What survives a terminal failure: keep the generated idea so a manual
 *  revival (or future salvage tooling) doesn't lose paid-for work. */
function terminalState(task: DiscoveryTaskRow): Record<string, unknown> {
  const idea = (task.phase_state as PhaseState).idea;
  return idea ? { idea } : {};
}

function generatorOf(task: DiscoveryTaskRow): DiscoveryModel {
  return task.generator as unknown as DiscoveryModel;
}
function scorerOf(task: DiscoveryTaskRow): DiscoveryModel {
  return task.scorer as unknown as DiscoveryModel;
}

/** Which model executes the CURRENT phase's research/synthesis. */
function phaseModel(task: DiscoveryTaskRow): DiscoveryModel {
  const status = task.status;
  if (status === "researching" || status === "pending") return generatorOf(task);
  if (status === "reframing") return pickReframer(task.run_id, task.idx);
  // Scoring/rescoring is ALWAYS the dual-model house panel (owner decision,
  // supersedes the cross-vendor scorer rule): Fable 5 max researches and
  // drafts, GPT-5.6 Sol reviews with its own browser access, Fable
  // finalizes weighing the feedback.
  const ps = task.phase_state as PhaseState;
  const panel = scoringPanel(scoringVariant(task.run_id, task.idx));
  if (ps.verdictDraft && !ps.feedback) return panel.reviewer;
  return panel.drafter;
}

function drafterProviderOf(task: DiscoveryTaskRow): "anthropic" | "openai" {
  const { drafter } = scoringPanel(scoringVariant(task.run_id, task.idx));
  return drafter.provider === "anthropic" ? "anthropic" : "openai";
}

function nextStep(task: DiscoveryTaskRow): Step | null {
  const ps = task.phase_state as PhaseState;
  const status = task.status;
  if (status === "done" || status === "failed") return null;
  if (status === "pending") return { kind: "init" };
  if (status === "generated") return { kind: "begin_scoring" };
  const phase = turnKeyFor(status);
  // Scoring phases: verdict awaiting publish/decide.
  if (ps.verdict) return { kind: "decide" };
  // Synthesis stage of the phase?
  if (ps.synthJobId) return { kind: "synth_poll", phase: "synth" };
  const researchDone = Boolean(ps.brief ?? ps.memo);
  if (!researchDone) return { kind: "research_turn", phase };
  const model = phaseModel(task);
  if (status === "scoring" || status === "rescoring") {
    // Dual-model panel: draft (Fable) → feedback loop (Sol, with browser)
    // → final (Fable). The feedback loop rides the research_turn machinery.
    if (ps.verdictDraft && !ps.feedback) return { kind: "research_turn", phase };
    return { kind: "score_sync", phase };
  }
  // Generation only: one red-team pass over the brief before synthesis.
  if (status === "researching" && !ps.critique) {
    return { kind: "critique", phase: "synth" };
  }
  // Generation/reframe synthesis: OpenAI = background pro; others sync.
  return model.provider === "openai"
    ? { kind: "synth_submit", phase: "synth" }
    : { kind: "synth_sync", phase };
}

function isPaid(step: Step): boolean {
  // Polls are free idempotent reads (design-chain precedent) — only the
  // SUBMIT of a background job consumes synthesis budget.
  return (
    step.kind !== "init" &&
    step.kind !== "decide" &&
    step.kind !== "begin_scoring" &&
    step.kind !== "synth_poll"
  );
}
function needsBrowser(step: Step): boolean {
  return step.kind === "research_turn";
}

// ---------------------------------------------------------------------------
// Verdict helpers.
// ---------------------------------------------------------------------------
function verdictToIdeaFields(
  idea: GeneratedIdea,
  verdict: AnalyzeResponse,
  id: string,
): Partial<Idea> {
  const gates = {} as Record<GateId, GateValue>;
  const gateRationales: Partial<Record<GateId, string>> = {};
  for (const [gid, g] of Object.entries(verdict.gates)) {
    gates[gid as GateId] = g.value === "UNSURE" ? null : g.value;
    if (g.rationale) gateRationales[gid as GateId] = g.rationale;
  }
  const scores = {} as Record<CriterionId, number | null>;
  const scoreRationales: Partial<Record<CriterionId, string>> = {};
  for (const [cid, s] of Object.entries(verdict.scores)) {
    scores[cid as CriterionId] = s.score;
    if (s.rationale) scoreRationales[cid as CriterionId] = s.rationale;
  }
  return {
    id,
    name: idea.name,
    domain: idea.domain,
    businessModel: idea.businessModel,
    buyerICP: idea.buyerICP,
    initialWedge: idea.initialWedge,
    thesisNotes: idea.thesisNotes,
    gates,
    scores,
    confidence: verdict.confidence,
    validationTest30d: verdict.validationTest30d,
    founderProfile: verdict.founderProfile,
    isPrivate: false,
    ai: {
      summary: verdict.summary,
      gateRationales,
      scoreRationales,
      confidenceRationale: verdict.confidenceRationale,
      needsFounderConfirmation: verdict.needsFounderConfirmation,
      provider: verdict.provider,
      model: verdict.model,
      analyzedAt: new Date().toISOString(),
      webSearches: 0, // browser tools were the research surface
    },
  };
}

export function verdictDecision(verdict: AnalyzeResponse): string | null {
  const gates = {} as Record<GateId, GateValue>;
  for (const [gid, g] of Object.entries(verdict.gates)) {
    gates[gid as GateId] = g.value === "UNSURE" ? null : g.value;
  }
  const scores = {} as Record<CriterionId, number | null>;
  for (const [cid, s] of Object.entries(verdict.scores)) {
    scores[cid as CriterionId] = s.score;
  }
  return decision({
    name: "candidate",
    gates,
    scores,
    confidence: verdict.confidence,
    weights: DEFAULT_WEIGHTS,
  });
}

export function verdictPasses(verdict: AnalyzeResponse): boolean {
  const dec = verdictDecision(verdict);
  return dec !== null && PASSING_DECISIONS.has(dec);
}

function verdictSummaryText(verdict: AnalyzeResponse): string {
  // The FULL verdict — a reframer rescuing an idea deserves everything the
  // scorer concluded, strengths included (they must be preserved, not just
  // weaknesses patched).
  const dec = verdictDecision(verdict) ?? "UNKNOWN";
  const gates = Object.entries(verdict.gates)
    .map(([gid, g]) => `- ${gid} [${g.value}]: ${g.rationale}`)
    .join("\n");
  const scores = Object.entries(verdict.scores)
    .map(([cid, s]) => `- ${cid}: ${s.score}/5 — ${s.rationale}`)
    .join("\n");
  return `Decision: ${dec}\n\n${verdict.summary}\n\nConfidence: ${verdict.confidence} — ${verdict.confidenceRationale}\n\nGates:\n${gates}\n\nScores:\n${scores}\n\n30-day validation test: ${verdict.validationTest30d}`.slice(
    0,
    20000,
  );
}

// ---------------------------------------------------------------------------
// Step execution.
// ---------------------------------------------------------------------------
interface StepContext {
  admin: SupabaseClient;
  run: DiscoveryRunRow;
  founderBackground: string;
  coFounders: Array<{ name: string; background: string }>;
  /** One-line digests of sibling candidates (novelty pressure). */
  siblings: string;
  session: BrowserHandle | null;
}

/** One Browserbase session shared by ALL tasks within an invocation —
 *  created lazily at the first browser-needing step, charged ONCE
 *  (pessimistically) per invocation, released by advanceDiscoveryRun. */
export interface SessionHolder {
  session: BrowserSession | null;
  overBudget: boolean;
  /** Hard create failure (bad keys, invalid params) — mirrored per-task in
   *  bb.failCount; 3 strikes fails the task terminally. */
  createFailed: boolean;
  /** The account's concurrent-session limit is taken (429) — TRANSIENT:
   *  another invocation holds the slot; skip browser work this tick with
   *  no strikes and try again next tick. */
  slotBusy: boolean;
  lastError?: string;
}

/** Executes the claimed step; returns the phase_state/status patch. */
async function executeStep(
  ctx: StepContext,
  task: DiscoveryTaskRow,
  step: Step,
): Promise<{
  status?: TaskStatus;
  phase_state?: Record<string, unknown>;
  error?: string | null;
  /** Stop this task's chunk after persisting (e.g. background job still
   *  pending — the next cron tick is the poll cadence). */
  yieldChunk?: boolean;
}> {
  const ps = task.phase_state as PhaseState;
  const gen = generatorOf(task);
  const round = roundForIdx(task.idx);

  // Self-heal: every post-generation phase needs the generated idea in
  // phase_state. If a crash/manual revival wiped it, restart the candidate
  // from scratch instead of crash-looping on ps.idea until the budget dies.
  // Deterministic idea ids make the eventual re-publish converge safely.
  const requiresIdea =
    task.status === "generated" ||
    task.status === "scoring" ||
    task.status === "reframing" ||
    task.status === "rescoring";
  if (requiresIdea && !ps.idea) {
    await logEvent(
      ctx.admin,
      ctx.run.id,
      task.idx,
      "state_reset",
      `phase_state lost its idea in status ${task.status} — restarting candidate`,
    );
    return { status: "pending", phase_state: {} };
  }

  if (step.kind === "init") {
    const system = buildDiscoveryResearchSystem({
      guidelines: ctx.run.guidelines,
      founderBackground: ctx.run.use_founder_background
        ? ctx.founderBackground
        : "",
      round,
      siblings: ctx.siblings,
    });
    return {
      status: "researching",
      phase_state: {
        loop: initialLoopState(
          gen.provider,
          system,
          buildDiscoveryResearchPrompt(ctx.run.guidelines),
        ),
      } as Record<string, unknown>,
    };
  }

  if (step.kind === "begin_scoring") {
    const idea = ps.idea!;
    const system = buildScoringResearchSystem(idea);
    return {
      status: "scoring",
      phase_state: {
        idea,
        loop: initialLoopState(
          drafterProviderOf(task), // the variant's drafter gathers evidence
          system,
          buildScoringResearchPrompt(),
        ),
      } as Record<string, unknown>,
    };
  }

  if (step.kind === "research_turn") {
    const model = phaseModel(task);
    const isReframe = task.status === "reframing";
    const feedbackMode =
      (task.status === "scoring" || task.status === "rescoring") &&
      Boolean(ps.verdictDraft) &&
      !ps.feedback;
    const system =
      task.status === "researching"
        ? buildDiscoveryResearchSystem({
            guidelines: ctx.run.guidelines,
            founderBackground: ctx.run.use_founder_background
              ? ctx.founderBackground
              : "",
            round,
            siblings: ctx.siblings,
          })
        : isReframe
          ? buildReframeResearchSystem({
              idea: ps.idea!,
              verdictSummary: ps.verdictSummary ?? "",
              history: ps.reframeHistory,
            })
          : feedbackMode
            ? buildScoringFeedbackSystem({
                idea: ps.idea!,
                draftVerdict: verdictSummaryText(ps.verdictDraft!),
                evidenceMemo: ps.memo ?? "",
              })
            : buildScoringResearchSystem(ps.idea!);
    const prompt =
      task.status === "researching"
        ? buildDiscoveryResearchPrompt(ctx.run.guidelines)
        : isReframe
          ? "Begin your reframe research now."
          : feedbackMode
            ? buildScoringFeedbackPrompt()
            : buildScoringResearchPrompt();
    const phase = turnKeyFor(task.status);
    const used = task.turns?.[phase] ?? 0;
    // Continuity guard: a loop STARTED on one provider must finish on it —
    // its serialized state is provider-shaped, and a mid-phase switch (e.g.
    // tasks in flight when the dual-panel scoring deployed) would feed that
    // state to the wrong API. New phases pick up the panel routing.
    let turnModel = model;
    if (ps.loop && !feedbackMode) {
      if (ps.loop.kind === "openai" && model.provider !== "openai") {
        turnModel = SCORER_OPENAI;
      } else if (
        ps.loop.kind === "anthropic" &&
        model.provider !== "anthropic"
      ) {
        turnModel = SCORER_ANTHROPIC;
      }
    }
    const result = await runResearchTurn({
      provider: turnModel.provider,
      model: turnModel.model,
      effort: turnModel.provider === "openrouter" ? undefined : "max",
      system,
      prompt,
      state: ps.loop ?? initialLoopState(model.provider, system, prompt),
      session: ctx.session!,
      // Two turns of headroom left → tell the agent to finish instead of
      // letting the budget kill it mid-research.
      wrapUp: used >= TURN_CAPS[phase] - 2,
    });
    const patch: PhaseState = { ...ps, loop: result.state };
    if (result.done) {
      const finalText = result.state.lastText ?? "";
      if (feedbackMode) {
        // Reviewer memo done — evidence memo/transcript stay untouched.
        patch.feedback = finalText || "(no feedback produced)";
      } else if (task.status === "scoring" || task.status === "rescoring") {
        patch.memo = finalText || "(no memo produced)";
        patch.researchLog = transcriptFromLoop(result.state);
      } else {
        patch.brief = finalText || "(no brief produced)";
        patch.researchLog = transcriptFromLoop(result.state);
      }
      patch.loop = undefined;
    }
    return { phase_state: patch as Record<string, unknown> };
  }

  if (step.kind === "critique") {
    const model = phaseModel(task);
    const critique = await plainTextCall({
      provider: model.provider,
      model: model.model,
      effort: model.provider === "openrouter" ? "high" : "max",
      system: buildCritiqueSystem(),
      prompt: ps.brief ?? "",
    });
    return {
      phase_state: { ...ps, critique: critique || "(no critique produced)" } as Record<
        string,
        unknown
      >,
    };
  }

  if (step.kind === "synth_submit") {
    const isReframe = task.status === "reframing";
    const feedbackMode =
      (task.status === "scoring" || task.status === "rescoring") &&
      Boolean(ps.verdictDraft) &&
      !ps.feedback;
    const jobId = await openaiSynthesisSubmit({
      model: phaseModel(task).model,
      system: isReframe
        ? buildReframeSynthesisSystem()
        : buildGenerationSynthesisSystem(),
      prompt: buildGenerationSynthesisPrompt(
        ps.brief ?? "",
        ps.critique,
        ps.researchLog,
      ),
      schemaName: "discovered_idea",
      schema: IDEA_GEN_SCHEMA as unknown as Record<string, unknown>,
    });
    return {
      phase_state: { ...ps, synthJobId: jobId } as Record<string, unknown>,
    };
  }

  if (step.kind === "synth_poll") {
    const poll = await openaiSynthesisPoll(ps.synthJobId!);
    if (poll.status === "pending") return { yieldChunk: true };
    if (poll.status === "expired") {
      // Result aged out — clear the job id; the next claim resubmits
      // (bounded by the synth turn cap).
      return {
        phase_state: { ...ps, synthJobId: undefined } as Record<
          string,
          unknown
        >,
      };
    }
    if (poll.status === "failed") {
      throw new Error(poll.error);
    }
    const idea = normalizeGeneratedIdea(poll.json);
    if (!idea) throw new Error("Synthesis returned an invalid idea shape.");
    return afterIdeaSynthesis(task, ps, idea);
  }

  if (step.kind === "synth_sync") {
    const model = phaseModel(task);
    const isReframe = task.status === "reframing";
    const feedbackMode =
      (task.status === "scoring" || task.status === "rescoring") &&
      Boolean(ps.verdictDraft) &&
      !ps.feedback;
    const raw = await runSynthesisSync({
      provider: model.provider as "anthropic" | "openrouter",
      model: model.model,
      effort: model.provider === "anthropic" ? "max" : undefined,
      system: isReframe
        ? buildReframeSynthesisSystem()
        : buildGenerationSynthesisSystem(),
      prompt: buildGenerationSynthesisPrompt(
        ps.brief ?? "",
        ps.critique,
        ps.researchLog,
      ),
      schemaName: "discovered_idea",
      schema: IDEA_GEN_SCHEMA as unknown as Record<string, unknown>,
    });
    const idea = normalizeGeneratedIdea(raw);
    if (!idea) throw new Error("Synthesis returned an invalid idea shape.");
    return afterIdeaSynthesis(task, ps, idea);
  }

  if (step.kind === "score_sync") {
    // Dual panel: the variant's drafter drafts AND finalizes; the other
    // house model reviews in between.
    const variant = scoringVariant(task.run_id, task.idx);
    const isFinal = Boolean(ps.verdictDraft && ps.feedback);
    const scorer = scoringPanel(variant).drafter;
    const system = buildScoringSynthesisSystem();
    const prompt = buildScoringSynthesisPrompt({
      idea: ps.idea!,
      founderBackground: ctx.run.use_founder_background
        ? ctx.founderBackground
        : "",
      coFounders: ctx.run.use_founder_background ? ctx.coFounders : [],
      evidenceMemo: ps.memo ?? "",
      researchLog: ps.researchLog,
      ...(isFinal
        ? {
            draftVerdict: verdictSummaryText(ps.verdictDraft!),
            reviewerFeedback: ps.feedback,
          }
        : {}),
    });
    const raw =
      scorer.provider === "anthropic"
        ? await runSynthesisSync({
            provider: "anthropic",
            model: scorer.model,
            effort: "max",
            system,
            prompt,
            schemaName: "idea_analysis",
            schema: ANALYSIS_SCHEMA as unknown as Record<string, unknown>,
          })
        : await openaiSynthesisSync({
            model: scorer.model,
            effort: "max",
            system,
            prompt,
            schemaName: "idea_analysis",
            schema: ANALYSIS_SCHEMA as unknown as Record<string, unknown>,
          });
    const verdict = normalizeAnalysis(
      raw as RawAnalysis,
      0,
      scorer.provider === "anthropic" ? "anthropic" : "openai",
      scorer.model,
    );
    if (!isFinal) {
      await logEvent(
        ctx.admin,
        ctx.run.id,
        task.idx,
        "scoring_variant",
        JSON.stringify({
          variant,
          stage: task.status,
          drafter: scorer.model,
          reviewer: scoringPanel(variant).reviewer.model,
        }),
      );
      return {
        phase_state: { ...ps, verdictDraft: verdict } as Record<
          string,
          unknown
        >,
      };
    }
    return {
      phase_state: {
        ...ps,
        verdict,
        verdictDraft: undefined,
        feedback: undefined,
        memo: undefined,
      } as Record<string, unknown>,
    };
  }

  // decide: route pass/fail; publish atomically. The ORIGINAL always
  // publishes with its verdict; a REFRAMED idea publishes only when it
  // passes or the rescue budget is spent (intermediate failed attempts
  // stay internal — deterministic ids leave no room for one row per try).
  const verdict = ps.verdict!;
  const isRescore = task.status === "rescoring";
  const attempt = ps.reframeAttempt ?? 0;
  const passes = verdictPasses(verdict);
  // Every scoring loop is durably recorded for future analysis (excluded
  // from event pruning).
  await logEvent(
    ctx.admin,
    ctx.run.id,
    task.idx,
    "reframe_loop",
    JSON.stringify({
      attempt,
      idea: ps.idea!.name,
      decision: verdictDecision(verdict),
      passes,
      variant: scoringVariant(task.run_id, task.idx),
      summary: verdict.summary?.slice(0, 1200) ?? "",
    }),
  );
  if (isRescore && !passes && attempt < MAX_REFRAME_LOOPS) {
    return {
      status: "reframing",
      phase_state: {
        idea: ps.idea,
        verdictSummary: verdictSummaryText(verdict),
        reframeAttempt: attempt + 1,
        reframeHistory: [
          ...(ps.reframeHistory ?? []),
          {
            name: ps.idea!.name,
            summary: verdictSummaryText(verdict).slice(0, 1500),
          },
        ],
      } as Record<string, unknown>,
    };
  }
  const ideaId = isRescore ? task.idea_reframe_id! : task.idea_original_id!;
  const fields = verdictToIdeaFields(ps.idea!, verdict, ideaId);
  await insertIdea(
    ctx.admin,
    {
      userId: ctx.run.owner_id,
      anonKey: null,
      isAdmin: false,
      subscribed: true,
    },
    fields,
  );
  // Best-effort provenance (server-only columns; tolerate pre-migration).
  try {
    await ctx.admin
      .from("ideas")
      .update({ discovery_run_id: ctx.run.id, origin: "discovery" })
      .eq("id", ideaId);
  } catch {
    // Migration drift — provenance degrades, idea stands.
  }
  if (!isRescore && !passes) {
    // Rescue path: iterative reframes (bounded by attempt count + the
    // reframe/rescore turn budgets, whichever binds first).
    return {
      status: "reframing",
      phase_state: {
        idea: ps.idea,
        verdictSummary: verdictSummaryText(verdict),
        reframeAttempt: 1,
        reframeHistory: [],
      } as Record<string, unknown>,
    };
  }
  return {
    status: "done",
    // The loop trail survives the task for future analysis.
    phase_state: (ps.reframeHistory?.length
      ? { loops: ps.reframeHistory }
      : {}) as Record<string, unknown>,
  };
}

/** After generation/reframe synthesis lands: route to scoring/rescoring. */
function afterIdeaSynthesis(
  task: DiscoveryTaskRow,
  ps: PhaseState,
  idea: GeneratedIdea,
): { status: TaskStatus; phase_state: Record<string, unknown> } {
  if (task.status === "reframing") {
    const ps = task.phase_state as PhaseState;
    return {
      status: "rescoring",
      phase_state: {
        idea,
        reframeAttempt: ps.reframeAttempt ?? 1,
        reframeHistory: ps.reframeHistory ?? [],
        loop: initialLoopState(
          drafterProviderOf(task), // the variant's drafter gathers evidence
          buildScoringResearchSystem(idea),
          buildScoringResearchPrompt(),
        ),
      } as Record<string, unknown>,
    };
  }
  return { status: "generated", phase_state: { idea } };
}

// ---------------------------------------------------------------------------
// Task advancement (claim → execute → persist, chunked by wall clock).
// ---------------------------------------------------------------------------
async function advanceTask(
  ctx: Omit<StepContext, "session">,
  taskIn: DiscoveryTaskRow,
  invocationDeadline: number,
  holder: SessionHolder,
): Promise<void> {
  let task = taskIn;
  let handle: BrowserHandle | null = null;
  const token = randomUUID();
  try {
    for (;;) {
      // A cancelled/failed run must stop mid-chunk, not at the next tick —
      // the user's brake applies between turns.
      const freshRun = await fetchRun(ctx.admin, ctx.run.id);
      if (!freshRun || freshRun.status !== "running") return;

      const step = nextStep(task);
      if (!step) return;
      const model = phaseModel(task);
      if (Date.now() + worstCaseMs(step, model.provider) > invocationDeadline) {
        return; // out of wall clock — another invocation continues
      }

      // Phase deadline (anchored at the phase's first claim).
      if (
        task.phase_started_at &&
        Date.now() - new Date(task.phase_started_at).getTime() >
          PHASE_DEADLINE_MS
      ) {
        await casUpdateTask(ctx.admin, task.id, task.rev, {
          status: "failed",
          error: `Phase ${task.status} exceeded its deadline.`,
          claim: null,
          phase_state: terminalState(task),
        });
        return;
      }

      // Budget checks at claim time.
      const phaseKey =
        step.kind === "synth_submit" ||
        step.kind === "synth_poll" ||
        step.kind === "critique" ||
        step.kind === "synth_sync"
          ? task.status === "reframing"
            ? "resynth"
            : "synth"
          : turnKeyFor(task.status);
      const used = task.turns?.[phaseKey] ?? 0;
      // Cap-death for a RESEARCH phase with work-in-progress gets one
      // forced-delivery overage: a no-tools turn that writes the brief/memo
      // from everything gathered, instead of discarding paid research.
      if (
        isPaid(step) &&
        used >= TURN_CAPS[phaseKey] &&
        step.kind === "research_turn"
      ) {
        const ps = task.phase_state as PhaseState;
        if (ps.loop && !ps.brief && !ps.memo && !ps.forcedWrapup) {
          const claimed = await casUpdateTask(ctx.admin, task.id, task.rev, {
            phase_state: { ...ps, forcedWrapup: true } as Record<string, unknown>,
            claim: { token, heartbeat_at: new Date().toISOString() },
          });
          if (!claimed) return;
          task = claimed;
          await logEvent(
            ctx.admin,
            ctx.run.id,
            task.idx,
            "forced_wrapup",
            `${phaseKey} cap reached with no deliverable — forcing a no-tools wrap-up turn`,
          );
          try {
            const model = phaseModel(task);
            const result = await runResearchTurn({
              provider: model.provider,
              model: model.model,
              effort: model.provider === "openrouter" ? "high" : "max",
              system: "",
              prompt: "",
              state: ps.loop,
              session: { sessionId: "", page: null as never },
              wrapUp: true,
              noTools: true,
            });
            const finalText = result.state.lastText ?? "";
            if (finalText) {
              const psNow = task.phase_state as PhaseState;
              const patch: PhaseState = { ...psNow, forcedWrapup: true };
              if (task.status === "scoring" || task.status === "rescoring") {
                patch.memo = finalText;
              } else {
                patch.brief = finalText;
              }
              patch.researchLog = transcriptFromLoop(result.state);
              patch.loop = undefined;
              const persisted = await casUpdateTask(ctx.admin, task.id, task.rev, {
                phase_state: patch as Record<string, unknown>,
                claim: { token, heartbeat_at: new Date().toISOString() },
              });
              if (persisted) {
                task = persisted;
                continue; // proceed to synthesis with the forced deliverable
              }
            }
          } catch (err) {
            await logEvent(
              ctx.admin,
              ctx.run.id,
              task.idx,
              "step_error",
              `forced wrap-up failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
      if (isPaid(step) && used >= TURN_CAPS[phaseKey]) {
        await logEvent(
          ctx.admin,
          ctx.run.id,
          task.idx,
          "budget_exhausted",
          `${phaseKey} ${used}/${TURN_CAPS[phaseKey]} — task failed`,
        );
        await casUpdateTask(ctx.admin, task.id, task.rev, {
          status: "failed",
          error: `Turn budget exhausted in ${phaseKey} (${used}/${TURN_CAPS[phaseKey]}).`,
          claim: null,
          phase_state: terminalState(task),
        });
        return;
      }

      // Browser session — SHARED across all tasks this invocation, one
      // fresh PAGE per task. Created FIRST, charged on success (a failed
      // create consumes nothing at Browserbase — charging first leaked the
      // whole minutes budget when creation was failing). Creation failures
      // are recorded ON THE TASK so the owner can see them; three strikes
      // fails the task terminally instead of retrying forever.
      if (needsBrowser(step)) {
        if (holder.slotBusy) {
          // Another invocation holds the account's only session slot —
          // leave a visible (non-terminal, non-strike) note and yield.
          await casUpdateTask(ctx.admin, task.id, task.rev, {
            error:
              "Waiting for a free browser slot (Browserbase concurrent-session limit reached) — retrying automatically.",
            claim: null,
          });
          return;
        }
        if (holder.overBudget || holder.createFailed) {
          const failCount = ((task.bb?.failCount as number) ?? 0) + 1;
          const terminal = holder.overBudget || failCount >= 3;
          await casUpdateTask(ctx.admin, task.id, task.rev, {
            ...(terminal
              ? { status: "failed" as const, phase_state: terminalState(task) }
              : {}),
            error: holder.overBudget
              ? "Browser-minutes budget exhausted for this run."
              : `Browser session failed (attempt ${failCount}/3): ${String(
                  holder.lastError ?? "unknown",
                ).slice(0, 300)}`,
            bb: { ...task.bb, failCount },
            claim: null,
          });
          return;
        }
        // A dead session (timeout/disconnect) must never masquerade as a
        // live one — recreate and re-charge instead of feeding every task
        // "Target closed" errors for the rest of the invocation.
        if (holder.session && !holder.session.browser.isConnected()) {
          await releaseBrowserSession(holder.session);
          holder.session = null;
        }
        if (!holder.session) {
          try {
            holder.session = await createBrowserSession();
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // A concurrency-limit 429 is TRANSIENT (someone else has the
            // slot) — never a strike. Everything else (bad keys, invalid
            // params) is a hard failure with bounded strikes.
            if (/429|concurrent/i.test(msg)) {
              holder.slotBusy = true;
            } else {
              holder.createFailed = true;
            }
            holder.lastError = msg;
            console.error("[discovery] browser session create failed:", msg);
            await logEvent(
              ctx.admin,
              ctx.run.id,
              task.idx,
              "browser_error",
              msg,
            );
            continue; // record on the task via the branches above
          }
          const minutes = Math.ceil(BB_SESSION_TIMEOUT_SECONDS / 60);
          const run = await bumpRunBudget(ctx.admin, ctx.run.id, {
            browserMinutes: minutes,
          });
          const total =
            (run?.budget as { browserMinutes?: number })?.browserMinutes ?? 0;
          if (run && total > BB_RUN_MINUTES_CAP) {
            holder.overBudget = true;
            continue;
          }
        }
        // A chunk can cross a phase boundary onto a model with different
        // vision capability — recreate the tab so blocking + view_page match.
        if (handle && (handle.vision ?? false) !== (model.vision ?? false)) {
          await closeTaskPage(handle);
          handle = null;
        }
        if (!handle) {
          try {
            handle = await createTaskPage(holder.session, model.vision ?? false);
          } catch (err) {
            // Dead browser between the isConnected check and newPage —
            // treat as transient (next iteration recreates the session)
            // and NEVER let it reject the whole worker pool.
            await releaseBrowserSession(holder.session);
            holder.session = null;
            await logEvent(
              ctx.admin,
              ctx.run.id,
              task.idx,
              "browser_error",
              `page create failed: ${err instanceof Error ? err.message : String(err)}`,
            );
            continue;
          }
        }
        // Persist the session + page ids on the task before use (leak audit
        // trail + live-view targeting; clears any earlier failure note).
        const withSession = await casUpdateTask(ctx.admin, task.id, task.rev, {
          bb: {
            sessionId: holder.session.sessionId,
            pageId: handle.targetId ?? null,
          },
          error: null,
          claim: { token, heartbeat_at: new Date().toISOString() },
        });
        if (!withSession) return;
        task = withSession;
      }

      // THE CLAIM: bump the turn counter (paid steps) + heartbeat, and set
      // the incoming status transition, all in one CAS.
      const claimed = await casUpdateTask(ctx.admin, task.id, task.rev, {
        ...(isPaid(step)
          ? { turns: { ...task.turns, [phaseKey]: used + 1 } }
          : {}),
        claim: { token, heartbeat_at: new Date().toISOString() },
        ...(task.status === "pending" || task.status === "generated"
          ? {}
          : {}),
        ...(task.phase_started_at ? {} : { phase_started_at: new Date().toISOString() }),
      });
      if (!claimed) return; // another worker holds the row
      task = claimed;
      await logEvent(
        ctx.admin,
        ctx.run.id,
        task.idx,
        "claim",
        `${step.kind} in ${task.status} (turn ${used + (isPaid(step) ? 1 : 0)}/${TURN_CAPS[phaseKey]}, model ${model.model})`,
      );

      if (isPaid(step)) {
        // Run-level total, pre-counted. null = CAS contention: fail CLOSED
        // for the spend (release the claim, retry next tick) — the task's
        // own bumped counter keeps retries bounded either way.
        const run = await bumpRunBudget(ctx.admin, ctx.run.id, {
          totalTurns: 1,
        });
        if (!run) {
          await casUpdateTask(ctx.admin, task.id, task.rev, { claim: null });
          return;
        }
        const totalTurns =
          (run.budget as { totalTurns?: number })?.totalTurns ?? 0;
        if (totalTurns > RUN_TOTAL_TURN_CAP) {
          await casUpdateTask(ctx.admin, task.id, task.rev, {
            status: "failed",
            error: "Run-level turn budget exhausted.",
            claim: null,
            phase_state: {},
          });
          return;
        }
        // Metering telemetry (attempted = spent). Awaited: supabase-js
        // builders are lazy thenables — a void'd builder NEVER executes.
        try {
          await ctx.admin.from("submission_logs").insert({
            user_id: ctx.run.owner_id,
            action: "discovery_turn",
            provider: model.provider,
            model: model.model,
          });
        } catch {
          // Telemetry only — never blocks the turn.
        }
      }

      // EXECUTE (the paid call — its budget slot is already claimed).
      let patch: Awaited<ReturnType<typeof executeStep>>;
      try {
        patch = await executeStep({ ...ctx, session: handle }, task, step);
      } catch (err) {
        // Record and release; the bumped counter bounds retries.
        const msg = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? (err.stack ?? "") : "";
        console.error(`[discovery] step ${step.kind} failed:`, msg);
        await logEvent(
          ctx.admin,
          ctx.run.id,
          task.idx,
          "step_error",
          `${step.kind} in ${task.status}: ${msg}\n${stack}`,
        );
        // Provider quota/rate-limit outages: HOLD the claim so the lease
        // doubles as a ~15-min backoff (immediate re-claims would burn the
        // turn budget against a billing problem). Self-heals: the claim
        // goes stale after CLAIM_LEASE_MS and the task resumes.
        const quotaOutage = /quota|billing|rate.?limit|429/i.test(msg);
        const failed = await casUpdateTask(ctx.admin, task.id, task.rev, {
          error: msg.slice(0, 500),
          claim: quotaOutage
            ? { token: "quota-backoff", heartbeat_at: new Date().toISOString() }
            : null,
        });
        if (failed) task = failed;
        return;
      }

      // PERSIST. Status transitions reset the phase clock.
      const statusChanges = patch.status && patch.status !== task.status;
      const persisted = await casUpdateTask(ctx.admin, task.id, task.rev, {
        ...(patch.status ? { status: patch.status } : {}),
        ...(patch.phase_state
          ? { phase_state: patch.phase_state }
          : {}),
        error: patch.error ?? null,
        claim: { token, heartbeat_at: new Date().toISOString() },
        ...(statusChanges
          ? { phase_started_at: new Date().toISOString() }
          : {}),
      });
      if (!persisted) return; // superseded — never re-execute paid work
      task = persisted;
      if (statusChanges) {
        await logEvent(
          ctx.admin,
          ctx.run.id,
          task.idx,
          "phase",
          `→ ${task.status}${task.error ? ` (${task.error})` : ""}`,
        );
      }

      if (task.status === "done" || task.status === "failed") {
        await casUpdateTask(ctx.admin, task.id, task.rev, { claim: null });
        return;
      }
      if (patch.yieldChunk) return; // e.g. background job pending — next tick polls
    }
  } finally {
    await closeTaskPage(handle);
    // The shared session is released by advanceDiscoveryRun, not here.
    // Release the claim if we still own the row (best-effort).
    try {
      if (task.claim?.token === token) {
        await casUpdateTask(ctx.admin, task.id, task.rev, { claim: null });
      }
    } catch {
      // Lease expiry lets others proceed regardless.
    }
  }
}

// ---------------------------------------------------------------------------
// Run advancement — the cron entry point.
// ---------------------------------------------------------------------------
export interface AdvanceResult {
  runId: string;
  status: string;
  advancedTasks: number;
}

export async function advanceDiscoveryRun(
  admin: SupabaseClient,
  runIn: DiscoveryRunRow,
  invocationDeadline: number,
): Promise<AdvanceResult> {
  let run = runIn;

  // Run deadline: fail everything still active.
  if (Date.now() > new Date(run.deadline_at).getTime()) {
    const tasks = await fetchTasks(admin, run.id);
    for (const t of tasks) {
      if (t.status !== "done" && t.status !== "failed") {
        await casUpdateTask(admin, t.id, t.rev, {
          status: "failed",
          error: "Run exceeded its 24h deadline.",
          claim: null,
          phase_state: terminalState(t),
        });
      }
    }
    const failed = await casUpdateRun(admin, run.id, run.rev, {
      status: "failed",
    });
    if (failed) await notifyOwner(admin, failed);
    return { runId: run.id, status: "failed", advancedTasks: 0 };
  }

  // Founding team (fetched once per invocation) — background AND
  // co-founders; scoring judges fmf on the strongest founder, so dropping
  // co-founders systematically mis-scored founder-market fit.
  let founderBackground = "";
  let coFounders: Array<{ name: string; background: string }> = [];
  if (run.use_founder_background) {
    const { data } = await admin
      .from("profiles")
      .select("founder_background, co_founders")
      .eq("id", run.owner_id)
      .maybeSingle<{
        founder_background: string | null;
        co_founders: Array<{ name?: string; background?: string }> | null;
      }>();
    founderBackground = data?.founder_background ?? "";
    coFounders = (data?.co_founders ?? [])
      .filter((c) => c && typeof c.background === "string" && c.background.trim())
      .map((c) => ({ name: c.name ?? "", background: c.background! }));
    if (coFounders.length > 0) {
      founderBackground += coFounders
        .map((c) => `\n\nCo-founder${c.name ? ` (${c.name})` : ""}: ${c.background}`)
        .join("");
    }
  }

  const tasks = await fetchTasks(admin, run.id);

  // A crash between createRun and createTasks leaves a task-less running
  // run that blocks the owner's slot forever — fail it once it's clearly
  // not mid-creation.
  if (
    tasks.length === 0 &&
    Date.now() - new Date(run.created_at).getTime() > 5 * 60 * 1000
  ) {
    const failed = await casUpdateRun(admin, run.id, run.rev, {
      status: "failed",
    });
    if (failed) await notifyOwner(admin, failed);
    return { runId: run.id, status: "failed", advancedTasks: 0 };
  }

  // Fisher–Yates so no task starves under the time budget.
  const active = tasks.filter(
    (t) => t.status !== "done" && t.status !== "failed",
  );
  for (let i = active.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [active[i], active[j]] = [active[j], active[i]];
  }

  // Novelty pressure: every generation agent sees a one-line digest of its
  // siblings' candidates and must stay clearly distinct.
  const siblings = tasks
    .map((t) => {
      const ps = t.phase_state as PhaseState;
      if (ps.idea) {
        return `- [${t.idx}] ${ps.idea.name} — ${ps.idea.domain} — ${ps.idea.initialWedge.slice(0, 100)}`;
      }
      if (ps.brief) return `- [${t.idx}] (drafting) ${ps.brief.slice(0, 120)}`;
      return null;
    })
    .filter(Boolean)
    .slice(0, 45)
    .join("\n");

  let advanced = 0;
  const holder: SessionHolder = {
    session: null,
    overBudget: false,
    createFailed: false,
    slotBusy: false,
  };
  // Advance several tasks CONCURRENTLY (each with its own page on the
  // shared browser) — sequential advancement dedicated a whole invocation
  // to one task and left the tail queued for tens of minutes.
  const CONCURRENCY = 12;
  const queue = [...active];
  try {
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
        for (;;) {
          const task = queue.shift();
          if (!task) return;
          if (Date.now() > invocationDeadline - 30_000) return;
          if (!claimAvailable(task)) continue;
          advanced++;
          await advanceTask(
            { admin, run, founderBackground, coFounders, siblings },
            task,
            invocationDeadline,
            holder,
          );
        }
      }),
    );
  } finally {
    await releaseBrowserSession(holder.session);
  }

  // Terminal check.
  const finalTasks = await fetchTasks(admin, run.id);
  const allTerminal =
    finalTasks.length > 0 &&
    finalTasks.every((t) => t.status === "done" || t.status === "failed");
  if (allTerminal && run.status === "running") {
    const fresh = await fetchRun(admin, run.id);
    if (fresh?.status === "running") {
      const done = await casUpdateRun(admin, run.id, fresh.rev, {
        status: finalTasks.some((t) => t.status === "done") ? "done" : "failed",
      });
      // Single CAS winner sends the email.
      if (done) {
        await logEvent(
          admin,
          run.id,
          null,
          "run_terminal",
          `${done.status}: ${finalTasks.filter((t) => t.status === "done").length}/${finalTasks.length} done`,
        );
        await notifyOwner(admin, done);
      }
      return { runId: run.id, status: done?.status ?? "running", advancedTasks: advanced };
    }
  }
  return { runId: run.id, status: run.status, advancedTasks: advanced };
}

async function notifyOwner(
  admin: SupabaseClient,
  run: DiscoveryRunRow,
): Promise<void> {
  try {
    if (run.notified_at) return;
    const marked = await casUpdateRun(admin, run.id, run.rev, {
      notified_at: new Date().toISOString(),
    });
    if (!marked) return; // another worker won the notify race
    const { data: profile } = await admin
      .from("profiles")
      .select("email")
      .eq("id", run.owner_id)
      .maybeSingle<{ email: string | null }>();
    if (!profile?.email) return;
    const tasks = await fetchTasks(admin, run.id);
    const found = tasks.filter((t) => t.status === "done").length;
    const app = process.env.NEXT_PUBLIC_APP_URL ?? "";
    const ok = run.status === "done";
    await sendEmail({
      to: profile.email,
      subject: ok
        ? `Your discovery run found ${found} idea${found === 1 ? "" : "s"}`
        : "Your discovery run needs another try",
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px">
  <h1 style="font-size:18px;color:#0f766e">Unicorn Idea Filter</h1>
  <p style="font-size:14px;color:#3f3f46">${
    ok
      ? `Your autonomous discovery run finished: <strong>${found}</strong> scored idea${found === 1 ? "" : "s"} ${found > 0 ? "are now in your pipeline (and the public database)" : "made it through"}.`
      : "Your discovery run stopped before finishing — you can start another from the Discover page."
  }</p>
  <p><a href="${app}/discover" style="display:inline-block;background:#0891b2;color:#fff;border-radius:6px;padding:10px 16px;text-decoration:none;font-size:14px">Open Discover</a></p>
</div>`,
    });
  } catch {
    // Mail failure never breaks the run (at-most-once semantics).
  }
}

/** Owner-facing activity feed: the last few things a task's agent did,
 *  extracted from its persisted loop state. System prompts are NEVER
 *  included (they can carry the founder background); tool results are
 *  summarized, not echoed. */
export function taskActivity(
  phaseState: Record<string, unknown>,
): Array<{ kind: "thought" | "tool"; text: string }> {
  const out: Array<{ kind: "thought" | "tool"; text: string }> = [];
  const push = (kind: "thought" | "tool", text: string) => {
    const t = text.trim();
    if (t) out.push({ kind, text: t.slice(0, 280) });
  };
  const loop = (phaseState as { loop?: LoopState }).loop;
  if (loop?.kind === "anthropic") {
    for (const m of loop.messages) {
      if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
      for (const block of m.content) {
        if (typeof block === "string") continue;
        if (block.type === "text") push("thought", block.text);
        if (block.type === "tool_use") {
          const input = block.input as { query?: string; url?: string };
          push("tool", `${block.name}: ${input?.query ?? input?.url ?? ""}`);
        }
      }
    }
  } else if (loop?.kind === "openrouter") {
    for (const m of loop.messages) {
      const msg = m as {
        role?: string;
        content?: unknown;
        tool_calls?: Array<{
          function?: { name?: string; arguments?: string };
        }>;
      };
      if (msg.role !== "assistant") continue;
      if (typeof msg.content === "string") push("thought", msg.content);
      for (const tc of msg.tool_calls ?? []) {
        push(
          "tool",
          `${tc.function?.name ?? "tool"}: ${(tc.function?.arguments ?? "").slice(0, 120)}`,
        );
      }
    }
  } else if (loop?.kind === "openai" && loop.lastText) {
    push("thought", loop.lastText);
  }
  const brief = (phaseState as { brief?: string; memo?: string });
  if (brief.brief) push("thought", `RESEARCH BRIEF: ${brief.brief}`);
  if (brief.memo) push("thought", `EVIDENCE MEMO: ${brief.memo}`);
  return out.slice(-5);
}

/** Crash between the terminal status flip and the send can drop the email —
 *  the cron sweeps recently-terminal unnotified runs (bounded window). */
export async function sweepNotifications(admin: SupabaseClient): Promise<void> {
  const runs = await listUnnotifiedTerminalRuns(admin);
  for (const run of runs) {
    await notifyOwner(admin, run);
  }
}

/** Deterministic idea ids for a new run's tasks. */
export function taskIdeaIds(runId: string, idx: number): {
  original: string;
  reframe: string;
} {
  return {
    original: deterministicUuid(`${runId}:${idx}:original`),
    reframe: deterministicUuid(`${runId}:${idx}:reframe`),
  };
}
