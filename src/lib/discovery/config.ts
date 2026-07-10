// Discovery engine — model panel, budgets, and cross-vendor policy.
// Every model id below was verified against provider docs on 2026-07-10;
// they live HERE (and only here) so a provider rename is a one-line fix.

/** Providers the discovery engine can call. Superset of the app-wide
 *  Provider union: 'openrouter' is discovery-only in v1 (not selectable in
 *  Settings), so the app-wide type stays untouched. */
export type DiscoveryProvider = "anthropic" | "openai" | "openrouter";

export interface DiscoveryModel {
  provider: DiscoveryProvider;
  model: string;
  /** Vendor for the cross-vendor rule (an idea is never scored by the
   *  company that generated it). OpenRouter models carry their upstream
   *  vendor, not "openrouter". */
  vendor: "openai" | "anthropic" | "deepseek" | "alibaba" | "google" | "meta";
  /** Vision-capable models browse with images/media unblocked and get the
   *  view_page screenshot tool (charts/tables/product UIs become visible).
   *  Only set where multimodal support is CONFIRMED — sending an image to
   *  a text-only model errors the turn. */
  vision?: boolean;
}

// ---------------------------------------------------------------------------
// Generation panel (~10 candidates/run: 2 per generator, see TASKS_PER_RUN).
// OpenAI: there is NO "-pro" model slug in the 5.6 generation — Pro is
// reasoning:{mode:'pro'} on gpt-5.6-sol, and background mode does NOT
// verifiably support tool loops. So the OpenAI generator researches with a
// sync tool loop (standard mode, effort high) and synthesizes the final idea
// with ONE background pro-mode call (no tools) — the design-chain pattern.
// ---------------------------------------------------------------------------
export const GEN_OPENAI: DiscoveryModel = {
  provider: "openai", model: "gpt-5.6-sol", vendor: "openai", vision: true,
};
export const GEN_ANTHROPIC: DiscoveryModel = {
  provider: "anthropic", model: "claude-fable-5", vendor: "anthropic", vision: true,
};
export const OPENROUTER_GENERATORS: DiscoveryModel[] = [
  { provider: "openrouter", model: "deepseek/deepseek-v4-pro", vendor: "deepseek" },
  { provider: "openrouter", model: "qwen/qwen3.7-max", vendor: "alibaba" },
  { provider: "openrouter", model: "google/gemini-3.1-pro-preview", vendor: "google", vision: true },
  { provider: "openrouter", model: "meta-llama/llama-4-maverick", vendor: "meta", vision: true },
];

/** The distinct generator models (for policy iteration/tests). */
export const GENERATORS: DiscoveryModel[] = [
  GEN_OPENAI,
  GEN_ANTHROPIC,
  ...OPENROUTER_GENERATORS,
];

/** Run composition (owner-specified): 20 candidates — 30% Fable 5, 30%
 *  GPT-5.6 Sol, the rest evenly split across the OpenRouter panel. */
/** Quality over quantity (owner decision): a discovery run develops ONE
 *  candidate deeply by default, up to three. House models (Fable 5 and
 *  GPT-5.6 Sol) take the first two slots; slot three samples the
 *  OpenRouter panel for diversity. */
export const DEFAULT_TASKS_PER_RUN = 1;
export const MAX_TASKS_PER_RUN = 3;

export function buildRunPanel(count: number): DiscoveryModel[] {
  const n = Math.min(MAX_TASKS_PER_RUN, Math.max(1, Math.round(count)));
  const house =
    Math.random() < 0.5
      ? [GEN_ANTHROPIC, GEN_OPENAI]
      : [GEN_OPENAI, GEN_ANTHROPIC];
  const panel = house.slice(0, n);
  if (n === 3) {
    panel.push(
      OPENROUTER_GENERATORS[
        Math.floor(Math.random() * OPENROUTER_GENERATORS.length)
      ],
    );
  }
  return panel;
}

/** Which occurrence of its model a slot is (1-based) — feeds the "pick a
 *  different wedge than your earlier attempt" diversity hint. */
export function roundForIdx(idx: number): number {
  const panel = buildRunPanel(MAX_TASKS_PER_RUN);
  const model = panel[idx]?.model;
  let n = 1;
  for (let i = 0; i < idx; i++) {
    if (panel[i]?.model === model) n++;
  }
  return n;
}

// Scorers (user-fixed): GPT-5.6 Sol thinking (max effort) or Opus 4.8 (max).
export const SCORER_OPENAI: DiscoveryModel = {
  provider: "openai", model: "gpt-5.6-sol", vendor: "openai", vision: true,
};
/** Scoring runs on the house flagships only (owner decision): Fable 5 at
 *  max effort or GPT-5.6 Sol — Opus 4.8 remains solely Fable's built-in
 *  refusal fallback. Cross-vendor rule unchanged: Fable never scores a
 *  Fable-generated idea. */
export const SCORER_ANTHROPIC: DiscoveryModel = {
  provider: "anthropic", model: "claude-fable-5", vendor: "anthropic", vision: true,
};

// Reframers (user-fixed): Fable 5 max or GPT-5.6 Sol pro-mode.
export const REFRAMER_ANTHROPIC: DiscoveryModel = {
  provider: "anthropic", model: "claude-fable-5", vendor: "anthropic", vision: true,
};
export const REFRAMER_OPENAI: DiscoveryModel = {
  provider: "openai", model: "gpt-5.6-sol", vendor: "openai", vision: true,
};

/** Cross-vendor rule: the scorer's company must differ from the company
 *  that produced the text being scored. OpenRouter vendors can be scored
 *  by either house scorer — alternate by idx for balance. */
/** Dual-panel A/B test (owner decision): who drafts and who reviews.
 *  A: Fable drafts -> Sol reviews -> Fable finalizes.
 *  B: Sol drafts -> Fable reviews -> Sol finalizes.
 *  Deterministic per (runId, idx) — mid-phase reassignment would corrupt
 *  loop state; recorded in scoring_variant events for later analysis. */
export type ScoringVariant = "A" | "B";

export function scoringVariant(runId: string, idx: number): ScoringVariant {
  return fnv1a(`${runId}:scorepanel:${idx}`) % 2 === 0 ? "A" : "B";
}

export function scoringPanel(variant: ScoringVariant): {
  drafter: DiscoveryModel;
  reviewer: DiscoveryModel;
} {
  return variant === "A"
    ? { drafter: SCORER_ANTHROPIC, reviewer: SCORER_OPENAI }
    : { drafter: SCORER_OPENAI, reviewer: SCORER_ANTHROPIC };
}

export function pickScorer(generator: DiscoveryModel, idx: number): DiscoveryModel {
  if (generator.vendor === "openai") return SCORER_ANTHROPIC;
  if (generator.vendor === "anthropic") return SCORER_OPENAI;
  return idx % 2 === 0 ? SCORER_ANTHROPIC : SCORER_OPENAI;
}

/** Dependency-free deterministic hash (FNV-1a). NOT crypto — just a stable
 *  "random" roll so a task resolves to the SAME reframer on every cron tick
 *  (a mid-phase model switch would corrupt its agent-loop state). Kept free
 *  of node:crypto because this module is imported by client pages. */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Reframer selection (owner-specified): 60% of the time the two house
 *  models handle it, rotating between each other; 40% of the time one of
 *  the other models gets the chance. Deterministic per (run, task). */
export function pickReframer(runId: string, idx: number): DiscoveryModel {
  const roll = fnv1a(`${runId}:${idx}:reframer`) % 100;
  if (roll < 60) {
    return idx % 2 === 0 ? REFRAMER_ANTHROPIC : REFRAMER_OPENAI;
  }
  const others = OPENROUTER_GENERATORS;
  return others[fnv1a(`${runId}:${idx}:other`) % others.length];
}

/** THE reframe cross-vendor rule: whoever wrote the reframe never grades
 *  it. OpenRouter-vendor reframers can be graded by either house scorer. */
export function pickRescorer(
  reframer: DiscoveryModel,
  idx: number,
): DiscoveryModel {
  if (reframer.vendor === "anthropic") return SCORER_OPENAI;
  if (reframer.vendor === "openai") return SCORER_ANTHROPIC;
  return idx % 2 === 0 ? SCORER_ANTHROPIC : SCORER_OPENAI;
}

// ---------------------------------------------------------------------------
// Spend budgets — the per-run worst case is computable from these. Counted
// AT CLAIM TIME on the task row (before any provider call), per invariant #1.
// ---------------------------------------------------------------------------
// Owner-sized budgets: deep research explicitly preferred over cost
// (~$1000+/run accepted). The engine nudges agents to wrap up two turns
// before a cap, so caps are a backstop rather than a common death.
export const TURN_CAPS = {
  research: 300,
  synth: 20,    // generation-synthesis SUBMITS (polls are free reads)
  resynth: 40,  // reframe-synthesis submits (own budget — never starved by gen)
  score: 150,   // the adversarial validator gets real depth, not 2/3 of it
  reframe: 600, // shared across up to MAX_REFRAME_LOOPS rescue loops
  rescore: 600,
} as const;

/** Rescue loops: reframe → rescore, repeated until the idea passes or the
 *  loop/turn budget is spent. Every loop is durably recorded
 *  (discovery_events kind 'reframe_loop', excluded from pruning) for
 *  future analysis. */
export const MAX_REFRAME_LOOPS = 10;
export type TurnPhase = keyof typeof TURN_CAPS;

/** Hard ceiling on total turns across ALL tasks in a run (20 tasks × ~200
 *  worst-case phase turns) — the last line of the spend envelope. */
export const RUN_TOTAL_TURN_CAP = 32_000;

/** Browserbase: minutes are charged pessimistically (a session's FULL
 *  timeout is added to the run budget inside the claim CAS that precedes
 *  creation — never refunded). */
/** Must OUTLIVE the 30-min worker invocation — at 300s the shared session
 *  died 5 minutes into 25-minute invocations and every later browser call
 *  hit a dead target. Self-terminates on CDP disconnect (no keepAlive). */
export const BB_SESSION_TIMEOUT_SECONDS = 1800;
/** One session is SHARED by all tasks within a cron invocation and charged
 *  once (pessimistically, at full timeout) — 180 covers ~36 browser-bearing
 *  invocations per run (~$0.40 of browser-hours), the real cost lever being
 *  model turns which TURN_CAPS bound. */
export const BB_RUN_MINUTES_CAP = 180_000; // ~3k browser-hours ≈ $300-750 — noise at this envelope

/** Lease: a task claim is stealable only when its heartbeat is older than
 *  this. Must exceed the worst single turn (max-effort reasoning call). */
export const CLAIM_LEASE_MS = 15 * 60 * 1000;

/** Wall-clock guards: stop starting new turns when the remaining invocation
 *  budget can't fit the worst case for that provider. */
export const WORST_TURN_MS = {
  premium: 720_000,   // max-effort turn streaming 32k tokens over a huge window
  openrouter: 240_000,
  synthesis: 720_000, // forced-schema synthesis / scoring call
} as const;

/** Cron work budget per invocation. Every worstCaseMs step bound MUST be
 *  strictly smaller than this or the step can never be claimed (guarded by
 *  a unit test). maxDuration=1800s (Vercel Pro 30-min beta) leaves 5 min
 *  of headroom above it. */
export const CRON_TIME_BUDGET_MS = 1_500_000;

/** Per-task serialized agent-loop state budget (chars of JSON.stringify).
 *  Sized for research QUALITY: at 60-turn research with 16k tool results,
 *  a small budget gave agents amnesia (oldest exchanges trimmed away).
 *  Postgres TOASTs large jsonb fine; the cost is input tokens, which the
 *  owner has explicitly accepted. State clears when a phase completes. */
export const TASK_STATE_CHAR_BUDGET = 1_600_000; // ≈400k tokens — full phase retention; models hold 1M
/** Per tool-result content cap (chars) before it enters loop history —
 *  16k keeps most articles/reports intact instead of cutting them at
 *  ~1000 words. */
export const TOOL_RESULT_CHAR_CAP = 60_000; // a full 25-page PDF / 10-K section survives intact

/** Deadlines are crash-detection backstops, not throughput levers. */
export const RUN_DEADLINE_MS = 96 * 60 * 60 * 1000;
export const PHASE_DEADLINE_MS = 24 * 60 * 60 * 1000; // anchored at first claim

/** Pass bar: decision ladder values that count as passing (≥ VALIDATE FAST). */
export const PASSING_DECISIONS = new Set(["BUILD / INCUBATE", "VALIDATE FAST"]);

// ---------------------------------------------------------------------------
// Daily-cap env brakes. Per the owner's explicit product decision these
// DEFAULT TO UNLIMITED when unset; set the env vars to enable a brake
// without a redeploy. (Red-team recommended fail-closed defaults — owner
// overrode; per-run budgets above still bound each run's worst case.)
// ---------------------------------------------------------------------------
export function userDailyCap(): number | null {
  const v = Number(process.env.DISCOVERY_USER_DAILY_CAP);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
}
export function globalDailyCap(): number | null {
  const v = Number(process.env.DISCOVERY_GLOBAL_DAILY_CAP);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
}

/** All four keys the engine needs; missing any → routes 503, UI hides. */
export function discoveryConfigured(): boolean {
  return Boolean(
    process.env.ANTHROPIC_API_KEY &&
      process.env.OPENAI_API_KEY &&
      process.env.OPENROUTER_API_KEY &&
      process.env.BROWSERBASE_API_KEY &&
      process.env.BROWSERBASE_PROJECT_ID,
  );
}
