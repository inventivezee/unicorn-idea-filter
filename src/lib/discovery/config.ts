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
  provider: "openai", model: "gpt-5.6-sol", vendor: "openai",
};
export const GEN_ANTHROPIC: DiscoveryModel = {
  provider: "anthropic", model: "claude-fable-5", vendor: "anthropic",
};
export const OPENROUTER_GENERATORS: DiscoveryModel[] = [
  { provider: "openrouter", model: "deepseek/deepseek-v4-pro", vendor: "deepseek" },
  { provider: "openrouter", model: "qwen/qwen3.7-max", vendor: "alibaba" },
  { provider: "openrouter", model: "google/gemini-3.1-pro-preview", vendor: "google" },
  { provider: "openrouter", model: "meta-llama/llama-4-maverick", vendor: "meta" },
];

/** The distinct generator models (for policy iteration/tests). */
export const GENERATORS: DiscoveryModel[] = [
  GEN_OPENAI,
  GEN_ANTHROPIC,
  ...OPENROUTER_GENERATORS,
];

/** Run composition (owner-specified): 20 candidates — 30% Fable 5, 30%
 *  GPT-5.6 Sol, the rest evenly split across the OpenRouter panel. */
export const TASKS_PER_RUN = 20;
const HOUSE_SLOTS = Math.ceil(TASKS_PER_RUN * 0.3); // 6 each

export function buildRunPanel(): DiscoveryModel[] {
  const panel: DiscoveryModel[] = [];
  for (let i = 0; i < HOUSE_SLOTS; i++) panel.push(GEN_OPENAI);
  for (let i = 0; i < HOUSE_SLOTS; i++) panel.push(GEN_ANTHROPIC);
  const rest = TASKS_PER_RUN - panel.length;
  for (let i = 0; i < rest; i++) {
    panel.push(OPENROUTER_GENERATORS[i % OPENROUTER_GENERATORS.length]);
  }
  return panel;
}

/** Which occurrence of its model a slot is (1-based) — feeds the "pick a
 *  different wedge than your earlier attempt" diversity hint. */
export function roundForIdx(idx: number): number {
  const panel = buildRunPanel();
  const model = panel[idx]?.model;
  let n = 1;
  for (let i = 0; i < idx; i++) {
    if (panel[i]?.model === model) n++;
  }
  return n;
}

// Scorers (user-fixed): GPT-5.6 Sol thinking (max effort) or Opus 4.8 (max).
export const SCORER_OPENAI: DiscoveryModel = {
  provider: "openai", model: "gpt-5.6-sol", vendor: "openai",
};
export const SCORER_ANTHROPIC: DiscoveryModel = {
  provider: "anthropic", model: "claude-opus-4-8", vendor: "anthropic",
};

// Reframers (user-fixed): Fable 5 max or GPT-5.6 Sol pro-mode.
export const REFRAMER_ANTHROPIC: DiscoveryModel = {
  provider: "anthropic", model: "claude-fable-5", vendor: "anthropic",
};
export const REFRAMER_OPENAI: DiscoveryModel = {
  provider: "openai", model: "gpt-5.6-sol", vendor: "openai",
};

/** Cross-vendor rule: the scorer's company must differ from the company
 *  that produced the text being scored. OpenRouter vendors can be scored
 *  by either house scorer — alternate by idx for balance. */
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
export const TURN_CAPS = {
  research: 15, // 12 nominal + 3 retry slack
  synth: 4,     // generation-synthesis SUBMITS (polls are free reads)
  resynth: 4,   // reframe-synthesis submits (own budget — never starved by gen)
  score: 13,    // 10 + 3
  reframe: 10,  // 8 + 2
  rescore: 13,  // 10 + 3
} as const;
export type TurnPhase = keyof typeof TURN_CAPS;

/** Hard cap on total turns across ALL tasks in a run (20 tasks × ~45
 *  worst-case would be ~900; the ceiling adds a little slack for synth
 *  resubmits). */
export const RUN_TOTAL_TURN_CAP = 1000;

/** Browserbase: minutes are charged pessimistically (a session's FULL
 *  timeout is added to the run budget inside the claim CAS that precedes
 *  creation — never refunded). */
export const BB_SESSION_TIMEOUT_SECONDS = 300; // 5 min, self-terminates
/** One session is SHARED by all tasks within a cron invocation and charged
 *  once (pessimistically, at full timeout) — 180 covers ~36 browser-bearing
 *  invocations per run (~$0.40 of browser-hours), the real cost lever being
 *  model turns which TURN_CAPS bound. */
export const BB_RUN_MINUTES_CAP = 360;

/** Lease: a task claim is stealable only when its heartbeat is older than
 *  this. Must exceed the worst single turn (max-effort reasoning call). */
export const CLAIM_LEASE_MS = 15 * 60 * 1000;

/** Wall-clock guards: stop starting new turns when the remaining invocation
 *  budget can't fit the worst case for that provider. */
export const WORST_TURN_MS = {
  premium: 240_000,   // max-effort Anthropic/OpenAI reasoning turn
  openrouter: 90_000,
  synthesis: 300_000, // forced-schema synthesis / scoring call
} as const;

/** Cron work budget per invocation. Every worstCaseMs step bound MUST be
 *  strictly smaller than this or the step can never be claimed (guarded by
 *  a unit test). maxDuration=800s leaves headroom above it. */
export const CRON_TIME_BUDGET_MS = 600_000;

/** Per-task serialized agent-loop state budget (chars of JSON.stringify).
 *  10 tasks × this must stay far under any row-size concern; state is
 *  cleared the moment a phase completes. */
export const TASK_STATE_CHAR_BUDGET = 45_000;
/** Per tool-result content cap (chars) before it enters loop history. */
export const TOOL_RESULT_CHAR_CAP = 6_000;

export const RUN_DEADLINE_MS = 24 * 60 * 60 * 1000;
export const PHASE_DEADLINE_MS = 3 * 60 * 60 * 1000; // anchored at first claim

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
