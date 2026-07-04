export const CRITERION_IDS = [
  "pain",
  "market",
  "whynow",
  "tenx",
  "wedge",
  "unitecon",
  "retention",
  "distribution",
  "moat",
  "pubco",
  "reg",
  "capital",
  "fmf",
  "talent",
  "mission",
] as const;

export type CriterionId = (typeof CRITERION_IDS)[number];

export const GATE_IDS = [
  "g_pain",
  "g_10b",
  "g_100m",
  "g_insight",
  "g_dist",
  "g_moat",
  "g_reg",
  "g_edge",
  "g_impact",
  "g_decade",
] as const;

export type GateId = (typeof GATE_IDS)[number];

export type GateValue = "Y" | "N" | null;
export type Confidence = 0.5 | 0.75 | 1.0 | null;

export type Provider = "anthropic" | "openai";

export type Decision =
  | "KILL / REFRAME"
  | "PENDING GATES"
  | "PENDING SCORES"
  | "BUILD / INCUBATE"
  | "VALIDATE FAST"
  | "PARK / NARROW"
  | "KILL";

export interface AIAnalysis {
  summary: string;
  gateRationales: Partial<Record<GateId, string>>;
  scoreRationales: Partial<Record<CriterionId, string>>;
  confidenceRationale: string;
  /** Gates the AI says only the founder can truly answer — confirm manually. */
  needsFounderConfirmation: GateId[];
  provider: Provider;
  model: string;
  analyzedAt: string;
}

export interface Idea {
  id: string;
  name: string;
  domain: string;
  businessModel: string;
  buyerICP: string;
  initialWedge: string;
  thesisNotes: string;
  gates: Record<GateId, GateValue>;
  scores: Record<CriterionId, number | null>;
  confidence: Confidence;
  topRiskOverride1?: string;
  topRiskOverride2?: string;
  validationTest30d: string;
  ai?: AIAnalysis | null;
  isExample?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Settings {
  weights: Record<CriterionId, number>;
  trials: number;
  provider: Provider;
  /** Model id per provider, remembered independently. */
  models: Record<Provider, string>;
  founderBackground: string;
}

export interface AppState {
  version: 1;
  ideas: Idea[];
  settings: Settings;
}

/** Shape returned by POST /api/analyze (already normalized server-side). */
export interface AnalyzeResponse {
  summary: string;
  gates: Record<GateId, { value: "Y" | "N" | "UNSURE"; rationale: string }>;
  scores: Record<CriterionId, { score: number; rationale: string }>;
  confidence: 0.5 | 0.75 | 1.0;
  confidenceRationale: string;
  validationTest30d: string;
  needsFounderConfirmation: GateId[];
  provider: Provider;
  model: string;
}
