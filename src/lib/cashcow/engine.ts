// Pure scoring engine for the Cash Cow Filter. Mirrors the source
// spreadsheet's semantics:
//  - raw score = Σ(score × weight) / (5 × Σweights) × 100 (weights sum to 100,
//    so raw reads as a percentage). Null until all 18 criteria are scored.
//  - adjusted = raw × confidence — a SORT KEY only, never a pass/fail target.
//  - gates come before scoring: any N kills.
//  - decision ladder (Dashboard sheet): BUILD/HOLD/EXIT needs all gates,
//    raw ≥ 80 and confidence ≥ 0.7; VALIDATE FAST raw ≥ 70; PARK/NARROW
//    raw 60–69; below 60 (or a failed gate) KILL/REFRAME.
import { CC_CRITERION_IDS, CC_GATE_IDS } from "../types";
import type {
  CcCriterionId,
  CcGateId,
  Confidence,
  GateValue,
} from "../types";
import { CC_CRITERIA_BY_ID, CC_WEIGHTS } from "./criteria";

export type CcScores = Record<CcCriterionId, number | null>;
export type CcGates = Record<CcGateId, GateValue>;
export type CcGateStatus = "PASS" | "FAIL" | "PENDING";

export type CcDecision =
  | "BUILD / HOLD / EXIT"
  | "VALIDATE FAST"
  | "PARK / NARROW"
  | "KILL / REFRAME"
  | "PENDING GATES"
  | "PENDING SCORES";

export function emptyCcGates(): CcGates {
  return Object.fromEntries(CC_GATE_IDS.map((id) => [id, null])) as CcGates;
}

export function emptyCcScores(): CcScores {
  return Object.fromEntries(
    CC_CRITERION_IDS.map((id) => [id, null]),
  ) as CcScores;
}

export function emptyCashCowBlock(): import("../types").CashCowBlock {
  return {
    gates: emptyCcGates(),
    scores: emptyCcScores(),
    confidence: null,
    validationTest30d: "",
  };
}

export function ccIsFullyScored(scores: CcScores): boolean {
  return CC_CRITERION_IDS.every((id) => typeof scores[id] === "number");
}

export function ccRawScore(scores: CcScores): number | null {
  if (!ccIsFullyScored(scores)) return null;
  let weighted = 0;
  let sumW = 0;
  for (const id of CC_CRITERION_IDS) {
    weighted += (scores[id] as number) * CC_WEIGHTS[id];
    sumW += CC_WEIGHTS[id];
  }
  if (sumW === 0) return null;
  return (weighted / (5 * sumW)) * 100;
}

/** Adjusted = raw × confidence. A sort key only — never a pass/fail target. */
export function ccAdjustedScore(
  raw: number | null,
  confidence: Confidence,
): number | null {
  if (raw === null || confidence === null) return null;
  return raw * confidence;
}

export function ccGateStatus(gates: CcGates): CcGateStatus {
  let pending = false;
  for (const id of CC_GATE_IDS) {
    if (gates[id] === "N") return "FAIL";
    if (gates[id] === null) pending = true;
  }
  return pending ? "PENDING" : "PASS";
}

export function ccDecision(input: {
  gates: CcGates;
  scores: CcScores;
  confidence: Confidence;
}): CcDecision {
  const status = ccGateStatus(input.gates);
  if (status === "FAIL") return "KILL / REFRAME";
  if (status === "PENDING") return "PENDING GATES";
  const raw = ccRawScore(input.scores);
  if (raw === null) return "PENDING SCORES";
  if (raw >= 80 && (input.confidence ?? 0) >= 0.7) return "BUILD / HOLD / EXIT";
  if (raw >= 70) return "VALIDATE FAST";
  if (raw >= 60) return "PARK / NARROW";
  return "KILL / REFRAME";
}

export interface CcRiskEntry {
  id: CcCriterionId;
  label: string;
  gap: number;
}

/** Biggest weighted gaps to a perfect score — the risks to attack first. */
export function ccTopRisks(scores: CcScores, count = 3): CcRiskEntry[] {
  const entries: CcRiskEntry[] = [];
  for (const id of CC_CRITERION_IDS) {
    const s = scores[id];
    if (typeof s !== "number") continue;
    entries.push({
      id,
      label: CC_CRITERIA_BY_ID[id].label,
      gap: (5 - s) * CC_WEIGHTS[id],
    });
  }
  entries.sort(
    (a, b) =>
      b.gap - a.gap ||
      CC_CRITERION_IDS.indexOf(a.id) - CC_CRITERION_IDS.indexOf(b.id),
  );
  return entries.slice(0, count).filter((e) => e.gap > 0);
}

/** Low scores on heavyweight criteria (score ≤ 2, weight ≥ 6) — kill signals. */
export function ccKillerFlags(scores: CcScores): CcCriterionId[] {
  return CC_CRITERION_IDS.filter((id) => {
    const s = scores[id];
    return typeof s === "number" && s <= 2 && CC_WEIGHTS[id] >= 6;
  });
}
