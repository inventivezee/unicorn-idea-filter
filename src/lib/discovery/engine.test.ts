import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "@/lib/ai/prompt";
import type { ORMessage } from "@/lib/ai/openrouter";
import { CRITERION_IDS, GATE_IDS } from "@/lib/types";
import type { AnalyzeResponse, GateId } from "@/lib/types";
import {
  GENERATORS,
  OPENROUTER_GENERATORS,
  DEFAULT_TASKS_PER_RUN,
  MAX_TASKS_PER_RUN,
  buildRunPanel,
  scoringPanel,
  scoringVariant,
  SCORER_ANTHROPIC,
  SCORER_OPENAI,
  TASK_STATE_CHAR_BUDGET,
  pickReframer,
  pickRescorer,
  pickScorer,
} from "./config";
import {
  deterministicUuid,
  reframeAttemptIdeaId,
  taskIdeaIds,
  verdictDecision,
  verdictPasses,
} from "./engine";
import { trimLoopState, type LoopState } from "./toolloop";
import { buildScoringSynthesisSystem, normalizeGeneratedIdea } from "./prompts";

// ---------------------------------------------------------------------------
// Deterministic ids — crash-retries must converge on the SAME idea row.
// ---------------------------------------------------------------------------
describe("deterministicUuid", () => {
  it("is stable for the same seed", () => {
    expect(deterministicUuid("run-1:0:original")).toBe(
      deterministicUuid("run-1:0:original"),
    );
  });

  it("differs across seeds", () => {
    expect(deterministicUuid("run-1:0:original")).not.toBe(
      deterministicUuid("run-1:1:original"),
    );
    expect(deterministicUuid("a")).not.toBe(deterministicUuid("b"));
  });

  it("matches the v4-style uuid shape", () => {
    const re =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/;
    for (const seed of ["x", "run:3:reframe", "", "🦄"]) {
      expect(deterministicUuid(seed)).toMatch(re);
    }
  });
});

describe("taskIdeaIds", () => {
  it("gives the original and the reframe distinct ids", () => {
    const ids = taskIdeaIds("run-abc", 3);
    expect(ids.original).not.toBe(ids.reframe);
  });

  it("is stable across calls (crash-retry convergence)", () => {
    expect(taskIdeaIds("run-abc", 3)).toEqual(taskIdeaIds("run-abc", 3));
  });

  it("differs across runs and task indices", () => {
    expect(taskIdeaIds("run-abc", 3).original).not.toBe(
      taskIdeaIds("run-abc", 4).original,
    );
    expect(taskIdeaIds("run-abc", 3).original).not.toBe(
      taskIdeaIds("run-def", 3).original,
    );
  });
});

// ---------------------------------------------------------------------------
// Cross-vendor policy — an idea is never scored by the company that wrote it.
// ---------------------------------------------------------------------------
describe("cross-vendor scoring policy", () => {
  it("never scores a house generator with its own vendor", () => {
    for (const gen of GENERATORS) {
      for (let idx = 0; idx < 10; idx++) {
        const scorer = pickScorer(gen, idx);
        if (gen.vendor === "openai" || gen.vendor === "anthropic") {
          expect(scorer.vendor).not.toBe(gen.vendor);
        }
      }
    }
  });

  it("always picks one of the two house scorers", () => {
    for (const gen of GENERATORS) {
      for (let idx = 0; idx < 10; idx++) {
        expect([SCORER_ANTHROPIC, SCORER_OPENAI]).toContain(
          pickScorer(gen, idx),
        );
      }
    }
  });

  it("rescorer vendor always differs from the reframer vendor", () => {
    // THE cross-vendor rule for reframes: whoever writes the reframe never
    // grades it — across many (run, task) seeds.
    for (let seed = 0; seed < 50; seed++) {
      for (let idx = 0; idx < 20; idx++) {
        const reframer = pickReframer(`run-${seed}`, idx);
        const rescorer = pickRescorer(reframer, idx);
        expect(rescorer.vendor).not.toBe(reframer.vendor);
        expect([SCORER_ANTHROPIC, SCORER_OPENAI]).toContain(rescorer);
      }
    }
  });

  it("reframer is deterministic per (run, idx) and follows the 60/40 policy", () => {
    // Same seed → same reframer on every cron tick (a mid-phase model
    // switch would corrupt the task's agent-loop state).
    for (let idx = 0; idx < 20; idx++) {
      expect(pickReframer("run-a", idx)).toBe(pickReframer("run-a", idx));
    }
    // Distribution: ~60% house (Fable/Sol rotating by idx parity), ~40%
    // other models — measured over many seeds, generous tolerance.
    let house = 0;
    let others = 0;
    const N = 2000;
    for (let i = 0; i < N; i++) {
      const r = pickReframer(`run-${i}`, i);
      if (r.vendor === "anthropic" || r.vendor === "openai") {
        house++;
        // Within the house bucket the two rotate by task parity.
        expect(r.vendor).toBe(i % 2 === 0 ? "anthropic" : "openai");
      } else {
        others++;
        expect(OPENROUTER_GENERATORS).toContain(r);
      }
    }
    expect(house / N).toBeGreaterThan(0.5);
    expect(house / N).toBeLessThan(0.7);
    expect(others / N).toBeGreaterThan(0.3);
  });
});

describe("reframeAttemptIdeaId", () => {
  it("attempt 1 keeps the task row's pre-assigned reframe id", () => {
    expect(reframeAttemptIdeaId("run-1", 3, 1)).toBe(
      taskIdeaIds("run-1", 3).reframe,
    );
    expect(reframeAttemptIdeaId("run-1", 3, 0)).toBe(
      taskIdeaIds("run-1", 3).reframe,
    );
  });

  it("later attempts get distinct deterministic ids", () => {
    const ids = [1, 2, 3].map((a) => reframeAttemptIdeaId("run-1", 3, a));
    expect(new Set(ids).size).toBe(3);
    expect(reframeAttemptIdeaId("run-1", 3, 2)).toBe(
      reframeAttemptIdeaId("run-1", 3, 2),
    );
  });
});

describe("scoring A/B variants", () => {
  it("is deterministic per (runId, idx)", () => {
    for (let idx = 0; idx < 5; idx++) {
      expect(scoringVariant("run-x", idx)).toBe(scoringVariant("run-x", idx));
    }
  });

  it("splits roughly 50/50 across seeds", () => {
    let a = 0;
    const N = 2000;
    for (let i = 0; i < N; i++) {
      if (scoringVariant(`run-${i}`, i % 3) === "A") a++;
    }
    expect(a / N).toBeGreaterThan(0.4);
    expect(a / N).toBeLessThan(0.6);
  });

  it("panel roles: A = Sol first / Fable final; B = the reverse", () => {
    const a = scoringPanel("A");
    expect(a.first.model).toBe("gpt-5.6-sol");
    expect(a.final.model).toBe("claude-fable-5");
    const b = scoringPanel("B");
    expect(b.first.model).toBe("claude-fable-5");
    expect(b.final.model).toBe("gpt-5.6-sol");
  });
});

describe("run panel composition (quality mode: 1-3 deep candidates)", () => {
  const HOUSE = ["claude-fable-5", "gpt-5.6-sol"];

  it("defaults are sane: 1 candidate, 20 max", () => {
    expect(DEFAULT_TASKS_PER_RUN).toBe(1);
    expect(MAX_TASKS_PER_RUN).toBe(20);
  });

  it("20 candidates → >=30% each house model, rest split evenly", () => {
    for (let i = 0; i < 20; i++) {
      const panel = buildRunPanel(20);
      expect(panel.length).toBe(20);
      const count = (m: string) => panel.filter((x) => x.model === m).length;
      expect(count("claude-fable-5")).toBeGreaterThanOrEqual(6);
      expect(count("gpt-5.6-sol")).toBeGreaterThanOrEqual(6);
      const others = OPENROUTER_GENERATORS.map((m) => count(m.model));
      // Evenly split: remainder slots make counts differ by at most 1.
      expect(Math.max(...others) - Math.min(...others)).toBeLessThanOrEqual(1);
    }
  });

  it("1 candidate → a single house model", () => {
    for (let i = 0; i < 50; i++) {
      const panel = buildRunPanel(1);
      expect(panel.length).toBe(1);
      expect(HOUSE).toContain(panel[0].model);
    }
  });

  it("2 candidates → exactly Fable + Sol", () => {
    for (let i = 0; i < 50; i++) {
      const models = buildRunPanel(2).map((m) => m.model);
      expect(models.length).toBe(2);
      expect(new Set(models)).toEqual(new Set(HOUSE));
    }
  });

  it("3 candidates → both house models + one OpenRouter generator", () => {
    for (let i = 0; i < 50; i++) {
      const panel = buildRunPanel(3);
      expect(panel.length).toBe(3);
      const models = panel.map((m) => m.model);
      expect(models).toContain("claude-fable-5");
      expect(models).toContain("gpt-5.6-sol");
      expect(OPENROUTER_GENERATORS.map((m) => m.model)).toContain(models[2]);
    }
  });

  it("clamps out-of-range counts", () => {
    expect(buildRunPanel(0).length).toBe(1);
    expect(buildRunPanel(99).length).toBe(20);
  });

});

// ---------------------------------------------------------------------------
// Verdict → decision routing (the pass/fail bar for publishing + reframe).
// ---------------------------------------------------------------------------
function makeVerdict(opts: {
  score?: number;
  confidence?: AnalyzeResponse["confidence"];
  gateOverrides?: Partial<Record<GateId, "Y" | "N" | "UNSURE">>;
} = {}): AnalyzeResponse {
  const gates = Object.fromEntries(
    GATE_IDS.map((id) => [
      id,
      { value: opts.gateOverrides?.[id] ?? "Y", rationale: "" },
    ]),
  ) as AnalyzeResponse["gates"];
  const scores = Object.fromEntries(
    CRITERION_IDS.map((id) => [id, { score: opts.score ?? 4, rationale: "" }]),
  ) as AnalyzeResponse["scores"];
  return {
    summary: "",
    metadata: {
      name: "Candidate",
      domain: "",
      businessModel: "",
      buyerICP: "",
      initialWedge: "",
    },
    founderProfile: "",
    gates,
    scores,
    confidence: opts.confidence ?? 0.75,
    confidenceRationale: "",
    validationTest30d: "",
    needsFounderConfirmation: [],
    provider: "anthropic",
    model: "claude-opus-4-8",
    webSearches: 0,
  };
}

describe("verdictDecision / verdictPasses", () => {
  it("all gates Y, all scores 4, confidence 0.75 → VALIDATE FAST (raw 80) → passes", () => {
    const verdict = makeVerdict();
    expect(verdictDecision(verdict)).toBe("VALIDATE FAST");
    expect(verdictPasses(verdict)).toBe(true);
  });

  it("all 5s → BUILD / INCUBATE → passes", () => {
    const verdict = makeVerdict({ score: 5 });
    expect(verdictDecision(verdict)).toBe("BUILD / INCUBATE");
    expect(verdictPasses(verdict)).toBe(true);
  });

  it("one gate N → KILL / REFRAME → fails", () => {
    const verdict = makeVerdict({ gateOverrides: { [GATE_IDS[0]]: "N" } });
    expect(verdictDecision(verdict)).toBe("KILL / REFRAME");
    expect(verdictPasses(verdict)).toBe(false);
  });

  it("all scores 3 (raw 60) → KILL → fails", () => {
    const verdict = makeVerdict({ score: 3 });
    expect(verdictDecision(verdict)).toBe("KILL");
    expect(verdictPasses(verdict)).toBe(false);
  });

  it("an UNSURE gate maps to null → PENDING GATES → fails", () => {
    const verdict = makeVerdict({ gateOverrides: { [GATE_IDS[0]]: "UNSURE" } });
    expect(verdictDecision(verdict)).toBe("PENDING GATES");
    expect(verdictPasses(verdict)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Loop-state trimming — history must fit the per-task budget without ever
// losing the system prompt or the first user prompt.
// ---------------------------------------------------------------------------
const BIG = "x".repeat(Math.ceil(TASK_STATE_CHAR_BUDGET / 12));

describe("trimLoopState", () => {
  it("trims an openrouter state under budget, preserving system + first user", () => {
    const exchanges: ORMessage[] = [];
    for (let i = 0; i < 15; i++) {
      exchanges.push(
        { role: "assistant", content: BIG },
        { role: "tool", tool_call_id: `call_${i}`, content: BIG },
      );
    }
    const state: LoopState = {
      kind: "openrouter",
      messages: [
        { role: "system", content: "the system prompt" },
        { role: "user", content: "the first user prompt" },
        ...exchanges,
      ],
    };
    expect(JSON.stringify(state).length).toBeGreaterThan(
      TASK_STATE_CHAR_BUDGET,
    );

    const trimmed = trimLoopState(state);
    expect(JSON.stringify(trimmed).length).toBeLessThanOrEqual(
      TASK_STATE_CHAR_BUDGET,
    );
    if (trimmed.kind !== "openrouter") throw new Error("kind changed");
    expect(trimmed.messages[0].role).toBe("system");
    expect(trimmed.messages[0].content).toBe("the system prompt");
    expect(trimmed.messages[1].role).toBe("user");
    expect(trimmed.messages[1].content).toBe("the first user prompt");
  });

  it("trims an anthropic state under budget, preserving the first message", () => {
    const exchanges: Extract<
      LoopState,
      { kind: "anthropic" }
    >["messages"] = [];
    for (let i = 0; i < 15; i++) {
      exchanges.push(
        { role: "assistant", content: BIG },
        { role: "user", content: BIG },
      );
    }
    const state: LoopState = {
      kind: "anthropic",
      messages: [{ role: "user", content: "the first user prompt" }, ...exchanges],
    };
    expect(JSON.stringify(state).length).toBeGreaterThan(
      TASK_STATE_CHAR_BUDGET,
    );

    const trimmed = trimLoopState(state);
    expect(JSON.stringify(trimmed).length).toBeLessThanOrEqual(
      TASK_STATE_CHAR_BUDGET,
    );
    if (trimmed.kind !== "anthropic") throw new Error("kind changed");
    expect(trimmed.messages[0].role).toBe("user");
    expect(trimmed.messages[0].content).toBe("the first user prompt");
  });

  it("leaves openai state untouched (history lives server-side)", () => {
    const state: LoopState = { kind: "openai", responseId: "resp_1", pending: [] };
    expect(trimLoopState(state)).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// Generated-idea normalization (synthesis output gate).
// ---------------------------------------------------------------------------
describe("normalizeGeneratedIdea", () => {
  const valid = {
    name: "Acme Grid",
    domain: "Energy",
    businessModel: "SaaS",
    buyerICP: "Utility operators",
    initialWedge: "Outage prediction",
    thesisNotes: "Grid telemetry is exploding.",
  };

  it("passes a valid idea through", () => {
    expect(normalizeGeneratedIdea(valid)).toEqual(valid);
  });

  it("rejects a missing name or thesisNotes", () => {
    expect(normalizeGeneratedIdea({ ...valid, name: undefined })).toBeNull();
    expect(normalizeGeneratedIdea({ ...valid, name: "" })).toBeNull();
    expect(
      normalizeGeneratedIdea({ ...valid, thesisNotes: undefined }),
    ).toBeNull();
    expect(normalizeGeneratedIdea(null)).toBeNull();
    expect(normalizeGeneratedIdea("just a string")).toBeNull();
  });

  it("slices overlong fields (name capped at 80 chars)", () => {
    const idea = normalizeGeneratedIdea({
      ...valid,
      name: "N".repeat(300),
      domain: "D".repeat(300),
      thesisNotes: "T".repeat(30_000),
    });
    expect(idea).not.toBeNull();
    expect(idea!.name).toHaveLength(80);
    expect(idea!.domain).toHaveLength(200);
    expect(idea!.thesisNotes).toHaveLength(20000);
  });

  it("trims whitespace and drops non-string fields to empty", () => {
    const idea = normalizeGeneratedIdea({
      ...valid,
      name: "  Acme Grid  ",
      buyerICP: 42,
    });
    expect(idea).not.toBeNull();
    expect(idea!.name).toBe("Acme Grid");
    expect(idea!.buyerICP).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Scorer prompt — provider-native web search stays OFF for discovery scoring
// (the browser loop is the only research surface).
// ---------------------------------------------------------------------------
describe("scoring synthesis system prompt", () => {
  it("is exactly the canonical evaluator prompt with a null search budget", () => {
    expect(buildScoringSynthesisSystem()).toBe(buildSystemPrompt(null));
  });

  it("promises no numeric live-search budget", () => {
    // webSearchRule(null) keeps the conditional "if a web search tool is
    // available" phrasing but never a capped budget — the discovery scorer
    // attaches no search tool, and the prompt must not promise one.
    expect(buildScoringSynthesisSystem()).not.toMatch(
      /do not exceed roughly \d+/i,
    );
  });
});

import { worstCaseMs } from "./engine";
import { CRON_TIME_BUDGET_MS } from "./config";

describe("step wall-clock bounds fit the cron budget", () => {
  const KINDS = [
    "init",
    "research_turn",
    "synth_submit",
    "synth_poll",
    "synth_sync",
    "score_sync",
    "decide",
    "begin_scoring",
  ] as const;
  const PROVIDERS = ["anthropic", "openai", "openrouter"];

  it("every step's worst case is strictly below CRON_TIME_BUDGET_MS", () => {
    for (const kind of KINDS) {
      for (const provider of PROVIDERS) {
        expect(worstCaseMs({ kind }, provider)).toBeLessThan(
          CRON_TIME_BUDGET_MS,
        );
      }
    }
  });
});
