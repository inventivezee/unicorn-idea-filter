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
  runResearchTurn,
  runSynthesisSync,
  type LoopState,
} from "./toolloop";
import {
  IDEA_GEN_SCHEMA,
  buildDiscoveryResearchPrompt,
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
  synthJobId?: string;
  verdictSummary?: string;
  verdict?: AnalyzeResponse;
  founderBackground?: string;
  round?: number;
}

type Step =
  | { kind: "init" }
  | { kind: "research_turn"; phase: TurnPhase }
  | { kind: "synth_submit"; phase: TurnPhase }
  | { kind: "synth_poll"; phase: TurnPhase }
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
  if (status === "scoring") return scorerOf(task);
  if (status === "reframing") return pickReframer(task.run_id, task.idx);
  return pickRescorer(pickReframer(task.run_id, task.idx), task.idx);
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
    return { kind: "score_sync", phase };
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
  const dec = verdictDecision(verdict) ?? "UNKNOWN";
  const failedGates = Object.entries(verdict.gates)
    .filter(([, g]) => g.value === "N")
    .map(([gid, g]) => `- FAILED ${gid}: ${g.rationale}`)
    .join("\n");
  const weakScores = Object.entries(verdict.scores)
    .filter(([, s]) => s.score <= 2)
    .map(([cid, s]) => `- ${cid} scored ${s.score}: ${s.rationale}`)
    .join("\n");
  return `Decision: ${dec}\n\n${verdict.summary}\n\n${failedGates}\n${weakScores}`.slice(
    0,
    4000,
  );
}

// ---------------------------------------------------------------------------
// Step execution.
// ---------------------------------------------------------------------------
interface StepContext {
  admin: SupabaseClient;
  run: DiscoveryRunRow;
  founderBackground: string;
  session: BrowserHandle | null;
}

/** One Browserbase session shared by ALL tasks within an invocation —
 *  created lazily at the first browser-needing step, charged ONCE
 *  (pessimistically) per invocation, released by advanceDiscoveryRun. */
export interface SessionHolder {
  session: BrowserSession | null;
  overBudget: boolean;
  /** Consecutive create failures this invocation (mirrored per-task in
   *  bb.failCount — 3 strikes fails the task terminally). */
  createFailed: boolean;
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

  if (step.kind === "init") {
    const system = buildDiscoveryResearchSystem({
      guidelines: ctx.run.guidelines,
      founderBackground: ctx.run.use_founder_background
        ? ctx.founderBackground
        : "",
      round,
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
    const scorer = scorerOf(task);
    const system = buildScoringResearchSystem(idea);
    return {
      status: "scoring",
      phase_state: {
        idea,
        loop: initialLoopState(
          scorer.provider === "anthropic" ? "anthropic" : "openai",
          system,
          buildScoringResearchPrompt(),
        ),
      } as Record<string, unknown>,
    };
  }

  if (step.kind === "research_turn") {
    const model = phaseModel(task);
    const isReframe = task.status === "reframing";
    const system =
      task.status === "researching"
        ? buildDiscoveryResearchSystem({
            guidelines: ctx.run.guidelines,
            founderBackground: ctx.run.use_founder_background
              ? ctx.founderBackground
              : "",
            round,
          })
        : isReframe
          ? buildReframeResearchSystem({
              idea: ps.idea!,
              verdictSummary: ps.verdictSummary ?? "",
            })
          : buildScoringResearchSystem(ps.idea!);
    const prompt =
      task.status === "researching"
        ? buildDiscoveryResearchPrompt(ctx.run.guidelines)
        : isReframe
          ? "Begin your reframe research now."
          : buildScoringResearchPrompt();
    const result = await runResearchTurn({
      provider: model.provider,
      model: model.model,
      effort: model.provider === "openrouter" ? undefined : "max",
      system,
      prompt,
      state: ps.loop ?? initialLoopState(model.provider, system, prompt),
      session: ctx.session!,
    });
    const patch: PhaseState = { ...ps, loop: result.state };
    if (result.done) {
      const finalText = result.state.lastText ?? "";
      if (task.status === "scoring" || task.status === "rescoring") {
        patch.memo = finalText || "(no memo produced)";
      } else {
        patch.brief = finalText || "(no brief produced)";
      }
      patch.loop = undefined; // research history no longer needed
    }
    return { phase_state: patch as Record<string, unknown> };
  }

  if (step.kind === "synth_submit") {
    const isReframe = task.status === "reframing";
    const jobId = await openaiSynthesisSubmit({
      model: phaseModel(task).model,
      system: isReframe
        ? buildReframeSynthesisSystem()
        : buildGenerationSynthesisSystem(),
      prompt: buildGenerationSynthesisPrompt(ps.brief ?? ""),
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
    const raw = await runSynthesisSync({
      provider: model.provider as "anthropic" | "openrouter",
      model: model.model,
      effort: model.provider === "anthropic" ? "max" : undefined,
      system: isReframe
        ? buildReframeSynthesisSystem()
        : buildGenerationSynthesisSystem(),
      prompt: buildGenerationSynthesisPrompt(ps.brief ?? ""),
      schemaName: "discovered_idea",
      schema: IDEA_GEN_SCHEMA as unknown as Record<string, unknown>,
    });
    const idea = normalizeGeneratedIdea(raw);
    if (!idea) throw new Error("Synthesis returned an invalid idea shape.");
    return afterIdeaSynthesis(task, ps, idea);
  }

  if (step.kind === "score_sync") {
    const scorer =
      task.status === "rescoring"
        ? pickRescorer(pickReframer(task.run_id, task.idx), task.idx)
        : scorerOf(task);
    const system = buildScoringSynthesisSystem();
    const prompt = buildScoringSynthesisPrompt({
      idea: ps.idea!,
      founderBackground: ctx.run.use_founder_background
        ? ctx.founderBackground
        : "",
      coFounders: [],
      evidenceMemo: ps.memo ?? "",
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
    return {
      phase_state: { ...ps, verdict, memo: undefined } as Record<
        string,
        unknown
      >,
    };
  }

  // decide: publish the scored idea atomically, then route pass/fail.
  const verdict = ps.verdict!;
  const isRescore = task.status === "rescoring";
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
  if (!isRescore && !verdictPasses(verdict)) {
    // One reframe retry: carry the failing idea + verdict into reframing.
    return {
      status: "reframing",
      phase_state: {
        idea: ps.idea,
        verdictSummary: verdictSummaryText(verdict),
      } as Record<string, unknown>,
    };
  }
  return { status: "done", phase_state: {} };
}

/** After generation/reframe synthesis lands: route to scoring/rescoring. */
function afterIdeaSynthesis(
  task: DiscoveryTaskRow,
  ps: PhaseState,
  idea: GeneratedIdea,
): { status: TaskStatus; phase_state: Record<string, unknown> } {
  if (task.status === "reframing") {
    const rescorer = pickRescorer(pickReframer(task.run_id, task.idx), task.idx);
    return {
      status: "rescoring",
      phase_state: {
        idea,
        loop: initialLoopState(
          rescorer.provider === "anthropic" ? "anthropic" : "openai",
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
          phase_state: {},
        });
        return;
      }

      // Budget checks at claim time.
      const phaseKey =
        step.kind === "synth_submit" || step.kind === "synth_poll"
          ? task.status === "reframing"
            ? "resynth"
            : "synth"
          : turnKeyFor(task.status);
      const used = task.turns?.[phaseKey] ?? 0;
      if (isPaid(step) && used >= TURN_CAPS[phaseKey]) {
        await casUpdateTask(ctx.admin, task.id, task.rev, {
          status: "failed",
          error: `Turn budget exhausted in ${phaseKey} (${used}/${TURN_CAPS[phaseKey]}).`,
          claim: null,
          phase_state: {},
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
        if (holder.overBudget || holder.createFailed) {
          const failCount = ((task.bb?.failCount as number) ?? 0) + 1;
          const terminal = holder.overBudget || failCount >= 3;
          await casUpdateTask(ctx.admin, task.id, task.rev, {
            ...(terminal ? { status: "failed" as const, phase_state: {} } : {}),
            error: holder.overBudget
              ? "Browser-minutes budget exhausted for this run."
              : `Browser session failed (attempt ${failCount}/3): ${String(
                  (holder as { lastError?: string }).lastError ?? "unknown",
                ).slice(0, 300)}`,
            bb: { ...task.bb, failCount },
            claim: null,
          });
          return;
        }
        if (!holder.session) {
          try {
            holder.session = await createBrowserSession();
          } catch (err) {
            holder.createFailed = true;
            (holder as { lastError?: string }).lastError =
              err instanceof Error ? err.message : String(err);
            continue; // record on the task via the branch above
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
        if (!handle) {
          handle = await createTaskPage(holder.session);
        }
        // Persist the session id on the task before use (leak audit trail;
        // clears any earlier failure note).
        const withSession = await casUpdateTask(ctx.admin, task.id, task.rev, {
          bb: { sessionId: holder.session.sessionId },
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
        const failed = await casUpdateTask(ctx.admin, task.id, task.rev, {
          error: msg.slice(0, 500),
          claim: null,
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
          phase_state: {},
        });
      }
    }
    const failed = await casUpdateRun(admin, run.id, run.rev, {
      status: "failed",
    });
    if (failed) await notifyOwner(admin, failed);
    return { runId: run.id, status: "failed", advancedTasks: 0 };
  }

  // Founder background (fetched once per invocation).
  let founderBackground = "";
  if (run.use_founder_background) {
    const { data } = await admin
      .from("profiles")
      .select("founder_background")
      .eq("id", run.owner_id)
      .maybeSingle<{ founder_background: string | null }>();
    founderBackground = data?.founder_background ?? "";
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

  let advanced = 0;
  const holder: SessionHolder = {
    session: null,
    overBudget: false,
    createFailed: false,
  };
  // Advance several tasks CONCURRENTLY (each with its own page on the
  // shared browser) — sequential advancement dedicated a whole invocation
  // to one task and left the tail queued for tens of minutes.
  const CONCURRENCY = 4;
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
            { admin, run, founderBackground },
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
      if (done) await notifyOwner(admin, done);
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
