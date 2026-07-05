import { describe, expect, it } from "vitest";
import { CC_CRITERIA } from "./criteria";
import {
  ccAdjustedScore,
  ccDecision,
  ccGateStatus,
  ccKillerFlags,
  ccRawScore,
  ccTopRisks,
  emptyCcGates,
  emptyCcScores,
} from "./engine";
import { CC_CRITERION_IDS, CC_GATE_IDS } from "../types";

function allScores(value: number) {
  return Object.fromEntries(
    CC_CRITERION_IDS.map((id) => [id, value]),
  ) as ReturnType<typeof emptyCcScores>;
}

describe("cash cow engine", () => {
  it("weights sum to 100 (they read as percentages)", () => {
    expect(CC_CRITERIA.reduce((sum, c) => sum + c.weight, 0)).toBe(100);
  });

  it("raw score is null until fully scored, then Σ(s·w)/5", () => {
    const scores = emptyCcScores();
    expect(ccRawScore(scores)).toBeNull();
    // all 5s → 100; all 4s → 80; all 3s → 60
    expect(ccRawScore(allScores(5))).toBeCloseTo(100);
    expect(ccRawScore(allScores(4))).toBeCloseTo(80);
    expect(ccRawScore(allScores(3))).toBeCloseTo(60);
  });

  it("gate status: any N fails, any null pending, else pass", () => {
    const gates = emptyCcGates();
    expect(ccGateStatus(gates)).toBe("PENDING");
    for (const id of CC_GATE_IDS) gates[id] = "Y";
    expect(ccGateStatus(gates)).toBe("PASS");
    gates.cg_control = "N";
    expect(ccGateStatus(gates)).toBe("FAIL");
  });

  it("decision ladder matches the spreadsheet dashboard", () => {
    const pass = emptyCcGates();
    for (const id of CC_GATE_IDS) pass[id] = "Y";

    // BUILD/HOLD/EXIT: gates pass, raw ≥ 80, confidence ≥ 0.7
    expect(
      ccDecision({ gates: pass, scores: allScores(4), confidence: 0.75 }),
    ).toBe("BUILD / HOLD / EXIT");
    // raw ≥ 80 but weak evidence → VALIDATE FAST
    expect(
      ccDecision({ gates: pass, scores: allScores(4), confidence: 0.5 }),
    ).toBe("VALIDATE FAST");
    // raw 60–69 → PARK / NARROW
    expect(
      ccDecision({ gates: pass, scores: allScores(3), confidence: 1.0 }),
    ).toBe("PARK / NARROW");
    // raw < 60 → KILL / REFRAME
    expect(
      ccDecision({ gates: pass, scores: allScores(2), confidence: 1.0 }),
    ).toBe("KILL / REFRAME");
    // failed gate dominates everything
    const failed = { ...pass, cg_conc: "N" as const };
    expect(
      ccDecision({ gates: failed, scores: allScores(5), confidence: 1.0 }),
    ).toBe("KILL / REFRAME");
    // unanswered gates → PENDING GATES
    expect(
      ccDecision({
        gates: emptyCcGates(),
        scores: allScores(5),
        confidence: 1.0,
      }),
    ).toBe("PENDING GATES");
    // gates pass, not fully scored → PENDING SCORES
    expect(
      ccDecision({ gates: pass, scores: emptyCcScores(), confidence: 1.0 }),
    ).toBe("PENDING SCORES");
  });

  it("adjusted is raw × confidence (sort key)", () => {
    expect(ccAdjustedScore(80, 0.75)).toBeCloseTo(60);
    expect(ccAdjustedScore(null, 0.75)).toBeNull();
    expect(ccAdjustedScore(80, null)).toBeNull();
  });

  it("top risks are the biggest weighted gaps", () => {
    const scores = allScores(5);
    scores.cc_ebitda = 1; // gap (5-1)*9 = 36
    scores.cc_fcf = 2; // gap (5-2)*8 = 24
    scores.cc_ops = 0; // gap (5-0)*4 = 20
    const risks = ccTopRisks(scores);
    expect(risks.map((r) => r.id)).toEqual(["cc_ebitda", "cc_fcf", "cc_ops"]);
  });

  it("killer flags: score ≤ 2 on weight ≥ 6 criteria", () => {
    const scores = allScores(5);
    scores.cc_ebitda = 2; // weight 9 → flagged
    scores.cc_ops = 0; // weight 4 → not flagged
    expect(ccKillerFlags(scores)).toEqual(["cc_ebitda"]);
  });
});
