import { describe, expect, it } from "vitest";
import {
  customAdjustedScore,
  customDecision,
  customGateStatus,
  customIsFullyScored,
  customKillerFlags,
  customRawScore,
  customTopRisks,
  emptyCustomBlock,
} from "./engine";
import { normalizeCustomFilterSpec, specToSnapshot } from "../types";
import type { CustomFilterSpec, CustomSpecSnapshot } from "../types";

function makeSpec(overrides?: Partial<CustomFilterSpec>): CustomFilterSpec {
  const spec = normalizeCustomFilterSpec({
    id: "f1",
    name: "Good Life Filter",
    question: "Can this reach $1M/yr net profit in 4 years at 8h/day, solo?",
    inputs: {
      netProfitTarget: 1_000_000,
      hoursPerDay: 8,
      yearsToBuild: 4,
      capitalAvailable: "$20k",
      maxTeamSize: "solo",
      wantsToSell: "no",
      otherQualities: "",
    },
    gates: [
      { label: "Solo-operable", yMeans: "y", nMeans: "n" },
      { label: "Reaches $1M/yr", yMeans: "y", nMeans: "n" },
      { label: "No VC needed", yMeans: "y", nMeans: "n" },
    ],
    criteria: [
      { label: "Margin", weight: 30, anchor0: "", anchor3: "", anchor5: "" },
      { label: "Automation", weight: 25, anchor0: "", anchor3: "", anchor5: "" },
      { label: "Demand", weight: 20, anchor0: "", anchor3: "", anchor5: "" },
      { label: "Moat", weight: 15, anchor0: "", anchor3: "", anchor5: "" },
      { label: "Founder fit", weight: 10, anchor0: "", anchor3: "", anchor5: "" },
    ],
    version: 1,
    createdAt: "2026-07-01T00:00:00.000Z",
  });
  if (!spec) throw new Error("fixture spec failed to normalize");
  return { ...spec, ...overrides };
}

function snap(): CustomSpecSnapshot {
  return specToSnapshot(makeSpec());
}

const allFive = { c1: 5, c2: 5, c3: 5, c4: 5, c5: 5 };
const allPass = { g1: "Y", g2: "Y", g3: "Y" } as const;

describe("normalizeCustomFilterSpec", () => {
  it("rescales weights to exactly 100 via largest remainder", () => {
    const spec = normalizeCustomFilterSpec({
      id: "x",
      name: "n",
      question: "q",
      gates: [
        { label: "a" },
        { label: "b" },
        { label: "c" },
      ],
      criteria: [
        { label: "1", weight: 1 },
        { label: "2", weight: 1 },
        { label: "3", weight: 1 },
        { label: "4", weight: 1 },
        { label: "5", weight: 1 },
        { label: "6", weight: 1 },
      ],
    });
    expect(spec).not.toBeNull();
    const total = spec!.criteria.reduce((s, c) => s + c.weight, 0);
    expect(total).toBe(100);
    // 100/6 = 16.67 → four 17s and two 16s (largest remainder)
    expect(spec!.criteria.map((c) => c.weight).sort((a, b) => a - b)).toEqual([
      16, 16, 17, 17, 17, 17,
    ]);
  });

  it("rejects specs with too few gates or criteria", () => {
    const base = {
      id: "x",
      name: "n",
      question: "q",
      gates: [{ label: "a" }, { label: "b" }, { label: "c" }],
      criteria: Array.from({ length: 5 }, (_, i) => ({
        label: `c${i}`,
        weight: 20,
      })),
    };
    expect(
      normalizeCustomFilterSpec({ ...base, gates: base.gates.slice(0, 2) }),
    ).toBeNull();
    expect(
      normalizeCustomFilterSpec({
        ...base,
        criteria: base.criteria.slice(0, 4),
      }),
    ).toBeNull();
    expect(normalizeCustomFilterSpec(base)).not.toBeNull();
  });

  it("assigns sequential ids regardless of model output", () => {
    const spec = makeSpec();
    expect(spec.gates.map((g) => g.id)).toEqual(["g1", "g2", "g3"]);
    expect(spec.criteria.map((c) => c.id)).toEqual([
      "c1",
      "c2",
      "c3",
      "c4",
      "c5",
    ]);
  });

  it("re-ids gates after dropping blank labels, so normalize is idempotent", () => {
    const spec = normalizeCustomFilterSpec({
      id: "x",
      name: "n",
      question: "q",
      gates: [{ label: "a" }, { label: "  " }, { label: "b" }, { label: "c" }],
      criteria: Array.from({ length: 5 }, (_, i) => ({
        label: `crit ${i}`,
        weight: 20,
      })),
    });
    expect(spec).not.toBeNull();
    expect(spec!.gates.map((g) => g.id)).toEqual(["g1", "g2", "g3"]);
    // Idempotency: normalizing the normalized spec changes nothing.
    const again = normalizeCustomFilterSpec(spec);
    expect(again).toEqual(spec);
  });
});

describe("normalizeCustomBlocks (via spec fixture)", () => {
  it("bounds ai fields and filters rationale keys to snapshot ids", async () => {
    const { normalizeCustomBlocks } = await import("../types");
    const snapshot = specToSnapshot(makeSpec());
    const blocks = normalizeCustomBlocks({
      f1: {
        gates: { g1: "Y" },
        scores: {},
        confidence: null,
        validationTest30d: "",
        snapshot,
        ai: {
          summary: "x".repeat(50_000),
          gateRationales: {
            g1: "y".repeat(50_000),
            bogus_key_not_in_snapshot: "z",
          },
          scoreRationales: { c1: "ok", not_a_criterion: "drop me" },
          confidenceRationale: "fine",
          needsFounderConfirmation: ["g1", "not-a-gate", "g2"],
          provider: "anthropic",
          model: "m",
          analyzedAt: "2026-07-01T00:00:00.000Z",
        },
      },
    });
    const ai = blocks?.f1?.ai;
    expect(ai).toBeTruthy();
    expect(ai!.summary.length).toBeLessThanOrEqual(5000);
    expect(ai!.gateRationales.g1.length).toBeLessThanOrEqual(2000);
    expect(Object.keys(ai!.gateRationales)).toEqual(["g1"]);
    expect(Object.keys(ai!.scoreRationales)).toEqual(["c1"]);
    expect(ai!.needsFounderConfirmation).toEqual(["g1", "g2"]);
  });
});

describe("custom engine", () => {
  it("raw score is null until fully scored, then Σ(score·weight)/(5·Σw)·100", () => {
    const s = snap();
    expect(customRawScore({ ...allFive, c3: null }, s)).toBeNull();
    expect(customRawScore(allFive, s)).toBe(100);
    // 3s across the board → 60
    expect(
      customRawScore({ c1: 3, c2: 3, c3: 3, c4: 3, c5: 3 }, s),
    ).toBeCloseTo(60);
  });

  it("adjusted = raw × confidence, null without either", () => {
    expect(customAdjustedScore(80, 0.75)).toBeCloseTo(60);
    expect(customAdjustedScore(null, 1)).toBeNull();
    expect(customAdjustedScore(80, null)).toBeNull();
  });

  it("gate status: any N fails, any unanswered pends, else passes", () => {
    const s = snap();
    expect(customGateStatus(allPass, s)).toBe("PASS");
    expect(customGateStatus({ ...allPass, g2: null }, s)).toBe("PENDING");
    expect(customGateStatus({ ...allPass, g2: "N" }, s)).toBe("FAIL");
    // FAIL wins over PENDING
    expect(customGateStatus({ g1: "N", g2: null, g3: null }, s)).toBe("FAIL");
  });

  it("decision ladder mirrors the built-ins", () => {
    const s = snap();
    const base = { gates: { ...allPass }, snapshot: s };
    expect(
      customDecision({ ...base, scores: allFive, confidence: 0.75 }),
    ).toBe("GO / BUILD");
    expect(
      customDecision({ ...base, scores: allFive, confidence: 0.5 }),
    ).toBe("VALIDATE FAST"); // ≥80 but low confidence
    expect(
      customDecision({
        ...base,
        scores: { c1: 3, c2: 3, c3: 3, c4: 3, c5: 3 },
        confidence: 1,
      }),
    ).toBe("PARK / NARROW"); // 60
    expect(
      customDecision({
        ...base,
        scores: { c1: 2, c2: 2, c3: 2, c4: 2, c5: 2 },
        confidence: 1,
      }),
    ).toBe("KILL / REFRAME"); // 40
    expect(
      customDecision({
        gates: { ...allPass, g1: "N" },
        scores: allFive,
        confidence: 1,
        snapshot: s,
      }),
    ).toBe("KILL / REFRAME"); // gate kill regardless of score
    expect(
      customDecision({
        gates: { ...allPass, g1: null },
        scores: allFive,
        confidence: 1,
        snapshot: s,
      }),
    ).toBe("PENDING GATES");
    expect(
      customDecision({ ...base, scores: { ...allFive, c1: null }, confidence: 1 }),
    ).toBe("PENDING SCORES");
  });

  it("top risks rank by weighted gap and drop zero-gap entries", () => {
    const s = snap();
    const risks = customTopRisks({ c1: 3, c2: 5, c3: 1, c4: 5, c5: 5 }, s);
    // c3 gap = 4·20 = 80, c1 gap = 2·30 = 60
    expect(risks.map((r) => r.id)).toEqual(["c3", "c1"]);
    expect(customTopRisks({ ...allFive, c1: null }, s)).toEqual([]);
  });

  it("killer flags require score ≤ 2 on an above-mean weight", () => {
    const s = snap(); // mean weight = 20
    expect(customKillerFlags({ c1: 2, c2: 5, c3: 5, c4: 2, c5: 1 }, s)).toEqual(
      ["c1"], // c4 (15) and c5 (10) are below the mean
    );
  });

  it("emptyCustomBlock keys every gate and criterion off the spec", () => {
    const block = emptyCustomBlock(makeSpec());
    expect(Object.keys(block.gates)).toEqual(["g1", "g2", "g3"]);
    expect(Object.keys(block.scores)).toEqual(["c1", "c2", "c3", "c4", "c5"]);
    expect(block.snapshot.version).toBe(1);
    expect(customIsFullyScored(block.scores, block.snapshot)).toBe(false);
  });
});
