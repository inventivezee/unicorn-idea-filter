// Pure, dependency-free scoring engine. No UI imports — testable standalone.
import { CRITERION_IDS, GATE_IDS } from "./types";
import type {
  Confidence,
  CriterionId,
  Decision,
  GateId,
  GateValue,
} from "./types";

export type GateStatus = "PASS" | "FAIL" | "PENDING";

export type Scores = Record<CriterionId, number | null>;
export type Gates = Record<GateId, GateValue>;
export type Weights = Record<CriterionId, number>;

export function sumWeights(weights: Weights): number {
  return CRITERION_IDS.reduce((acc, id) => acc + (weights[id] ?? 0), 0);
}

export function isFullyScored(scores: Scores): boolean {
  return CRITERION_IDS.every(
    (id) => scores[id] !== null && scores[id] !== undefined,
  );
}

/** 0–100, normalized by weight sum. Null unless all 15 criteria are scored. */
export function rawScore(scores: Scores, weights: Weights): number | null {
  if (!isFullyScored(scores)) return null;
  const sumW = sumWeights(weights);
  if (sumW <= 0) return null;
  const weighted = CRITERION_IDS.reduce(
    (acc, id) => acc + (scores[id] as number) * (weights[id] ?? 0),
    0,
  );
  return (weighted / (5 * sumW)) * 100;
}

/** rawScore × confidence; null unless both present. */
export function adjustedScore(
  raw: number | null,
  confidence: Confidence,
): number | null {
  if (raw === null || confidence === null) return null;
  return raw * confidence;
}

export function gateStatus(gates: Gates): GateStatus {
  if (GATE_IDS.some((id) => gates[id] === "N")) return "FAIL";
  if (GATE_IDS.some((id) => gates[id] === null || gates[id] === undefined))
    return "PENDING";
  return "PASS";
}

export function decision(input: {
  name: string;
  gates: Gates;
  scores: Scores;
  confidence: Confidence;
  weights: Weights;
}): Decision | null {
  if (!input.name) return null;
  const gs = gateStatus(input.gates);
  if (gs === "FAIL") return "KILL / REFRAME";
  if (gs === "PENDING") return "PENDING GATES";
  const raw = rawScore(input.scores, input.weights);
  if (raw === null) return "PENDING SCORES";
  if (raw >= 85 && input.confidence !== null && input.confidence >= 0.75) {
    // gateStatus PASS is already guaranteed at this point
    return "BUILD / INCUBATE";
  }
  if (raw >= 75) return "VALIDATE FAST";
  if (raw >= 65) return "PARK / NARROW";
  return "KILL";
}

export interface RiskEntry {
  id: CriterionId;
  pointsLost: number;
}

/**
 * pointsLost_i = (5 − score_i) × weight_i, tie-broken deterministically by
 * criterion index. Returns the two highest-loss criteria. Null unless fully scored.
 */
export function topRisks(
  scores: Scores,
  weights: Weights,
): [RiskEntry, RiskEntry] | null {
  if (!isFullyScored(scores)) return null;
  const entries: RiskEntry[] = CRITERION_IDS.map((id) => ({
    id,
    pointsLost: (5 - (scores[id] as number)) * (weights[id] ?? 0),
  }));
  // Stable sort by pointsLost desc; ties keep canonical criterion order.
  const sorted = entries
    .map((e, index) => ({ ...e, index }))
    .sort((a, b) => b.pointsLost - a.pointsLost || a.index - b.index);
  return [
    { id: sorted[0].id, pointsLost: sorted[0].pointsLost },
    { id: sorted[1].id, pointsLost: sorted[1].pointsLost },
  ];
}

/** Criteria with score ≤ 2 AND weight ≥ 8 — "low score on a heavy weight". */
export function killerFlags(scores: Scores, weights: Weights): CriterionId[] {
  return CRITERION_IDS.filter((id) => {
    const s = scores[id];
    return s !== null && s !== undefined && s <= 2 && (weights[id] ?? 0) >= 8;
  });
}

export const KILLER_FLAG_COPY =
  "low score on a heavy weight — validate it, don't average it.";

/** Deterministic PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface StressTestResult {
  leaderId: string;
  leaderName: string;
  robustnessPct: number;
  trials: number;
  fullyScoredCount: number;
}

export interface StressTestIdea {
  id: string;
  name: string;
  scores: Scores;
}

export const STRESS_TEST_SEED = 1337;

/**
 * Among fully-scored ideas, find the raw-score leader, then run `trials`
 * perturbations (each weight × uniform(0.8, 1.2), seeded mulberry32) and count
 * how often the base leader remains #1. Ties count as holds.
 */
export function stressTest(
  ideas: StressTestIdea[],
  weights: Weights,
  trials: number,
  seed: number = STRESS_TEST_SEED,
): StressTestResult | null {
  const scored = ideas.filter((i) => i.name && isFullyScored(i.scores));
  if (scored.length === 0 || trials <= 0 || sumWeights(weights) <= 0) {
    return null;
  }

  const baseScores = scored.map((i) => rawScore(i.scores, weights) as number);
  let leaderIdx = 0;
  for (let i = 1; i < scored.length; i++) {
    if (baseScores[i] > baseScores[leaderIdx]) leaderIdx = i;
  }
  const leader = scored[leaderIdx];

  const rand = mulberry32(seed);
  let holds = 0;
  for (let t = 0; t < trials; t++) {
    const perturbed = {} as Weights;
    for (const id of CRITERION_IDS) {
      perturbed[id] = (weights[id] ?? 0) * (0.8 + rand() * 0.4);
    }
    const leaderScore = rawScore(leader.scores, perturbed) as number;
    let isLeader = true;
    for (const idea of scored) {
      if (idea.id === leader.id) continue;
      if ((rawScore(idea.scores, perturbed) as number) > leaderScore) {
        isLeader = false;
        break;
      }
    }
    if (isLeader) holds++;
  }

  return {
    leaderId: leader.id,
    leaderName: leader.name,
    robustnessPct: (holds / trials) * 100,
    trials,
    fullyScoredCount: scored.length,
  };
}
