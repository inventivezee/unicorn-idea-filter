// Pure scoring engine for founder-designed custom filters. Same structural
// semantics as the built-in instruments — gates before scores, raw =
// Σ(score·weight)/(5·Σweights)·100 (null until fully scored), adjusted =
// raw × confidence as a sort key — but driven by a stored spec/snapshot
// instead of hard-coded criteria.
import type {
  Confidence,
  CustomBlock,
  CustomFilterSpec,
  CustomSpecSnapshot,
  GateValue,
} from "../types";
import { specToSnapshot } from "../types";

export type CustomGateStatus = "PASS" | "FAIL" | "PENDING";

export type CustomDecision =
  | "GO / BUILD"
  | "VALIDATE FAST"
  | "PARK / NARROW"
  | "KILL / REFRAME"
  | "PENDING GATES"
  | "PENDING SCORES";

export function emptyCustomBlock(spec: CustomFilterSpec): CustomBlock {
  return {
    gates: Object.fromEntries(spec.gates.map((g) => [g.id, null])),
    scores: Object.fromEntries(spec.criteria.map((c) => [c.id, null])),
    confidence: null,
    validationTest30d: "",
    snapshot: specToSnapshot(spec),
  };
}

export function customIsFullyScored(
  scores: Record<string, number | null>,
  snapshot: CustomSpecSnapshot,
): boolean {
  return snapshot.criteria.every((c) => typeof scores[c.id] === "number");
}

export function customRawScore(
  scores: Record<string, number | null>,
  snapshot: CustomSpecSnapshot,
): number | null {
  if (!customIsFullyScored(scores, snapshot)) return null;
  let weighted = 0;
  let sumW = 0;
  for (const c of snapshot.criteria) {
    weighted += (scores[c.id] as number) * c.weight;
    sumW += c.weight;
  }
  if (sumW === 0) return null;
  return (weighted / (5 * sumW)) * 100;
}

/** Adjusted = raw × confidence. A sort key only — never a pass/fail target. */
export function customAdjustedScore(
  raw: number | null,
  confidence: Confidence,
): number | null {
  if (raw === null || confidence === null) return null;
  return raw * confidence;
}

export function customGateStatus(
  gates: Record<string, GateValue>,
  snapshot: CustomSpecSnapshot,
): CustomGateStatus {
  let pending = false;
  for (const g of snapshot.gates) {
    if (gates[g.id] === "N") return "FAIL";
    if (gates[g.id] === null || gates[g.id] === undefined) pending = true;
  }
  return pending ? "PENDING" : "PASS";
}

/** Same ladder shape as the built-ins: any gate N kills; ≥80 with solid
 *  evidence goes; ≥70 validates; 60–69 parks; below kills. */
export function customDecision(input: {
  gates: Record<string, GateValue>;
  scores: Record<string, number | null>;
  confidence: Confidence;
  snapshot: CustomSpecSnapshot;
}): CustomDecision {
  const status = customGateStatus(input.gates, input.snapshot);
  if (status === "FAIL") return "KILL / REFRAME";
  if (status === "PENDING") return "PENDING GATES";
  const raw = customRawScore(input.scores, input.snapshot);
  if (raw === null) return "PENDING SCORES";
  if (raw >= 80 && (input.confidence ?? 0) >= 0.7) return "GO / BUILD";
  if (raw >= 70) return "VALIDATE FAST";
  if (raw >= 60) return "PARK / NARROW";
  return "KILL / REFRAME";
}

export interface CustomRiskEntry {
  id: string;
  label: string;
  gap: number;
}

/** Biggest weighted gaps to a perfect score — only when fully scored. */
export function customTopRisks(
  scores: Record<string, number | null>,
  snapshot: CustomSpecSnapshot,
  count = 3,
): CustomRiskEntry[] {
  if (!customIsFullyScored(scores, snapshot)) return [];
  return snapshot.criteria
    .map((c) => ({
      id: c.id,
      label: c.label,
      gap: (5 - (scores[c.id] as number)) * c.weight,
    }))
    .sort((a, b) => b.gap - a.gap)
    .slice(0, count)
    .filter((e) => e.gap > 0);
}

/** Low scores on heavyweight criteria (score ≤ 2, weight above the mean). */
export function customKillerFlags(
  scores: Record<string, number | null>,
  snapshot: CustomSpecSnapshot,
): string[] {
  const meanWeight = 100 / Math.max(1, snapshot.criteria.length);
  return snapshot.criteria
    .filter((c) => {
      const s = scores[c.id];
      return typeof s === "number" && s <= 2 && c.weight >= meanWeight;
    })
    .map((c) => c.id);
}
