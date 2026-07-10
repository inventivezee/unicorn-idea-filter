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
export const GENERATORS: DiscoveryModel[] = [
  { provider: "openai", model: "gpt-5.6-sol", vendor: "openai" },
  { provider: "anthropic", model: "claude-fable-5", vendor: "anthropic" },
  { provider: "openrouter", model: "deepseek/deepseek-v4-pro", vendor: "deepseek" },
  { provider: "openrouter", model: "qwen/qwen3.7-max", vendor: "alibaba" },
  { provider: "openrouter", model: "google/gemini-3.1-pro-preview", vendor: "google" },
];

/** Candidates per run: one per generator × this many rounds. 5 × 2 = 10. */
export const ROUNDS_PER_GENERATOR = 2;
export const TASKS_PER_RUN = GENERATORS.length * ROUNDS_PER_GENERATOR;

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

/** The reframer must differ from the vendor whose verdict it is rescuing
 *  is irrelevant — what matters is the RESCORER differs from the REFRAMER. */
export function pickReframer(scorer: DiscoveryModel): DiscoveryModel {
  // Alternate house: if the failing verdict came from Anthropic's scorer,
  // reframe with OpenAI's (and vice versa) so the subsequent rescore can
  // go back to the original scorer while staying cross-vendor.
  return scorer.vendor === "anthropic" ? REFRAMER_OPENAI : REFRAMER_ANTHROPIC;
}

export function pickRescorer(reframer: DiscoveryModel): DiscoveryModel {
  return reframer.vendor === "openai" ? SCORER_ANTHROPIC : SCORER_OPENAI;
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

/** Hard cap on total turns across ALL tasks in a run (10 tasks × ~45 nominal
 *  would be 450; the cap adds no slack on purpose — it's the ceiling). */
export const RUN_TOTAL_TURN_CAP = 500;

/** Browserbase: minutes are charged pessimistically (a session's FULL
 *  timeout is added to the run budget inside the claim CAS that precedes
 *  creation — never refunded). */
export const BB_SESSION_TIMEOUT_SECONDS = 300; // 5 min, self-terminates
/** One session is SHARED by all tasks within a cron invocation and charged
 *  once (pessimistically, at full timeout) — 180 covers ~36 browser-bearing
 *  invocations per run (~$0.40 of browser-hours), the real cost lever being
 *  model turns which TURN_CAPS bound. */
export const BB_RUN_MINUTES_CAP = 180;

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
