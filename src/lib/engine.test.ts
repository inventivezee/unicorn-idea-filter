import { describe, expect, it } from "vitest";
import { DEFAULT_WEIGHTS } from "./criteria";
import {
  adjustedScore,
  decision,
  gateStatus,
  killerFlags,
  rawScore,
  stressTest,
  topRisks,
  type Gates,
  type Scores,
} from "./engine";
import { CRITERION_IDS, GATE_IDS } from "./types";
import type { Confidence } from "./types";

function allGates(value: "Y" | "N" | null): Gates {
  return Object.fromEntries(GATE_IDS.map((id) => [id, value])) as Gates;
}

function makeScores(values: Partial<Record<string, number | null>>): Scores {
  const base = Object.fromEntries(
    CRITERION_IDS.map((id) => [id, null]),
  ) as Scores;
  return { ...base, ...values };
}

const FIXTURE_SCORES = makeScores({
  pain: 4,
  market: 5,
  whynow: 4,
  tenx: 3,
  wedge: 4,
  unitecon: 3,
  retention: 3,
  distribution: 2,
  moat: 3,
  pubco: 3,
  reg: 3,
  capital: 3,
  fmf: 5,
  talent: 3,
  mission: 3,
});

describe("acceptance test 1: spec fixture", () => {
  it("produces rawScore 70.4, adjusted 52.8, PARK / NARROW, correct risks and flags", () => {
    const raw = rawScore(FIXTURE_SCORES, DEFAULT_WEIGHTS);
    expect(raw).toBeCloseTo(70.4, 10);

    const adjusted = adjustedScore(raw, 0.75);
    expect(adjusted).toBeCloseTo(52.8, 10);

    expect(
      decision({
        name: "Fixture",
        gates: allGates("Y"),
        scores: FIXTURE_SCORES,
        confidence: 0.75,
        weights: DEFAULT_WEIGHTS,
      }),
    ).toBe("PARK / NARROW");

    const risks = topRisks(FIXTURE_SCORES, DEFAULT_WEIGHTS);
    expect(risks?.[0].id).toBe("distribution");
    expect(risks?.[1].id).toBe("moat");

    expect(killerFlags(FIXTURE_SCORES, DEFAULT_WEIGHTS)).toEqual([
      "distribution",
    ]);
  });
});

describe("acceptance test 2: gates dominate", () => {
  it("any gate N → KILL / REFRAME regardless of scores", () => {
    const gates = allGates("Y");
    gates.g_moat = "N";
    const perfect = makeScores(
      Object.fromEntries(CRITERION_IDS.map((id) => [id, 5])),
    );
    expect(
      decision({
        name: "X",
        gates,
        scores: perfect,
        confidence: 1.0,
        weights: DEFAULT_WEIGHTS,
      }),
    ).toBe("KILL / REFRAME");
  });

  it("any gate null (no N) → PENDING GATES", () => {
    const gates = allGates("Y");
    gates.g_decade = null;
    expect(
      decision({
        name: "X",
        gates,
        scores: FIXTURE_SCORES,
        confidence: 1.0,
        weights: DEFAULT_WEIGHTS,
      }),
    ).toBe("PENDING GATES");
  });

  it("gates pass but scores incomplete → PENDING SCORES", () => {
    expect(
      decision({
        name: "X",
        gates: allGates("Y"),
        scores: makeScores({ pain: 4 }),
        confidence: 1.0,
        weights: DEFAULT_WEIGHTS,
      }),
    ).toBe("PENDING SCORES");
  });
});

describe("acceptance test 3: confidence gate on BUILD", () => {
  // All 5s except a couple to land at exactly 86:
  // need Σ(score×weight)/(5×100)×100 = 86 → Σ score×weight = 430.
  // All 5s gives 500. Drop pain to 0 (−40), whynow to 0 (−40) → 420. Not 86.
  // Instead: market 5→0 (−60), reg 3 pts... build directly:
  // Use weights: drop tenx (8) from 5 to 0 → 460; drop unitecon (7) 5→1 → 460−28=432;
  // drop talent (2) 5→4 → 430. rawScore = 86.
  const scores86 = makeScores({
    ...Object.fromEntries(CRITERION_IDS.map((id) => [id, 5])),
    tenx: 0,
    unitecon: 1,
    talent: 4,
  });

  it("fixture arithmetic sanity: rawScore is 86", () => {
    expect(rawScore(scores86, DEFAULT_WEIGHTS)).toBeCloseTo(86, 10);
  });

  it("rawScore 86 + confidence 0.5 → VALIDATE FAST (not BUILD)", () => {
    expect(
      decision({
        name: "X",
        gates: allGates("Y"),
        scores: scores86,
        confidence: 0.5,
        weights: DEFAULT_WEIGHTS,
      }),
    ).toBe("VALIDATE FAST");
  });

  it("rawScore 86 + confidence 0.75 → BUILD / INCUBATE", () => {
    expect(
      decision({
        name: "X",
        gates: allGates("Y"),
        scores: scores86,
        confidence: 0.75,
        weights: DEFAULT_WEIGHTS,
      }),
    ).toBe("BUILD / INCUBATE");
  });

  it("rawScore below 65 → KILL", () => {
    const low = makeScores(
      Object.fromEntries(CRITERION_IDS.map((id) => [id, 1])),
    );
    expect(
      decision({
        name: "X",
        gates: allGates("Y"),
        scores: low,
        confidence: 1.0,
        weights: DEFAULT_WEIGHTS,
      }),
    ).toBe("KILL");
  });
});

describe("acceptance test 4: weight normalization", () => {
  it("weights summing ≠ 100 still yield 0–100 raw scores", () => {
    const doubled = Object.fromEntries(
      CRITERION_IDS.map((id) => [id, DEFAULT_WEIGHTS[id] * 2]),
    ) as Record<(typeof CRITERION_IDS)[number], number>;
    // Doubling every weight must not change the normalized score.
    expect(rawScore(FIXTURE_SCORES, doubled)).toBeCloseTo(70.4, 10);

    const lopsided = Object.fromEntries(
      CRITERION_IDS.map((id) => [id, 1]),
    ) as Record<(typeof CRITERION_IDS)[number], number>;
    const raw = rawScore(FIXTURE_SCORES, lopsided);
    expect(raw).not.toBeNull();
    expect(raw!).toBeGreaterThanOrEqual(0);
    expect(raw!).toBeLessThanOrEqual(100);
  });
});

describe("acceptance test 5: stress test", () => {
  const ideaA = { id: "a", name: "A", scores: FIXTURE_SCORES };
  const ideaB = {
    id: "b",
    name: "B",
    scores: makeScores(Object.fromEntries(CRITERION_IDS.map((id) => [id, 3]))),
  };

  it("is deterministic for a given state (seeded)", () => {
    const r1 = stressTest([ideaA, ideaB], DEFAULT_WEIGHTS, 300);
    const r2 = stressTest([ideaA, ideaB], DEFAULT_WEIGHTS, 300);
    expect(r1).not.toBeNull();
    expect(r1).toEqual(r2);
  });

  it("returns 100% when only one idea is fully scored", () => {
    const partial = {
      id: "p",
      name: "P",
      scores: makeScores({ pain: 5 }),
    };
    const r = stressTest([ideaA, partial], DEFAULT_WEIGHTS, 300);
    expect(r?.leaderId).toBe("a");
    expect(r?.robustnessPct).toBe(100);
    expect(r?.fullyScoredCount).toBe(1);
  });

  it("counts ties as holds", () => {
    const twin = { id: "twin", name: "Twin", scores: FIXTURE_SCORES };
    const r = stressTest([ideaA, twin], DEFAULT_WEIGHTS, 300);
    expect(r?.robustnessPct).toBe(100);
  });
});

describe("gateStatus", () => {
  it("PASS only when every gate is Y", () => {
    expect(gateStatus(allGates("Y"))).toBe("PASS");
    expect(gateStatus(allGates(null))).toBe("PENDING");
    const mixed = allGates("Y");
    mixed.g_pain = "N";
    expect(gateStatus(mixed)).toBe("FAIL");
  });

  it("FAIL wins over PENDING", () => {
    const gates = allGates(null);
    gates.g_pain = "N";
    expect(gateStatus(gates)).toBe("FAIL");
  });
});

describe("adjustedScore", () => {
  it("is null when either input is missing", () => {
    expect(adjustedScore(null, 0.75)).toBeNull();
    expect(adjustedScore(70, null as Confidence)).toBeNull();
  });
});
