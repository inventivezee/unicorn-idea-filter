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
  /** Live web searches the model ran, when web search was enabled. */
  webSearches?: number;
}

/** A clarifying question and the founder's answer, saved with the idea. */
export interface Clarification {
  question: string;
  answer: string;
}

/** Coerce arbitrary input into a clean, capped Clarification[] (DB/local/import). */
export function normalizeClarifications(value: unknown): Clarification[] {
  if (!Array.isArray(value)) return [];
  const out: Clarification[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const { question, answer } = raw as {
      question?: unknown;
      answer?: unknown;
    };
    if (typeof question !== "string" || !question.trim()) continue;
    out.push({
      question: question.trim().slice(0, 300),
      // Multi-select answers concatenate several detailed options, so allow room.
      answer: typeof answer === "string" ? answer.trim().slice(0, 1200) : "",
    });
    if (out.length >= 10) break;
  }
  return out;
}

export interface Idea {
  id: string;
  name: string;
  domain: string;
  businessModel: string;
  buyerICP: string;
  initialWedge: string;
  thesisNotes: string;
  /** Clarifying Q&A gathered when the idea was added. */
  clarifications?: Clarification[];
  gates: Record<GateId, GateValue>;
  scores: Record<CriterionId, number | null>;
  confidence: Confidence;
  topRiskOverride1?: string;
  topRiskOverride2?: string;
  validationTest30d: string;
  ai?: AIAnalysis | null;
  isExample?: boolean;
  /** Cloud mode: excluded from the public feed (subscriber feature). */
  isPrivate?: boolean;
  /** Cloud mode: visible in the public feed once scored (and not private). */
  published?: boolean;
  /** Anonymised founding-team profile shown publicly with the idea. */
  founderProfile?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CoFounder {
  id: string;
  name: string;
  background: string;
}

export interface Settings {
  weights: Record<CriterionId, number>;
  trials: number;
  provider: Provider;
  /** Model id per provider, remembered independently. */
  models: Record<Provider, string>;
  /** Primary founder — required before an idea can be analyzed. */
  founderBackground: string;
  /** Optional co-founders; fmf scores as the strongest founder's fit. */
  coFounders: CoFounder[];
  /** Let the model ground its analysis with live web searches. */
  webSearch: boolean;
  /** Ask AI clarifying questions before adding an idea (more accurate scoring). */
  askClarifying: boolean;
}

export interface AppState {
  version: 1;
  ideas: Idea[];
  settings: Settings;
}

/** Metadata the AI infers from a free-text idea description. */
export interface IdeaMetadataProposal {
  name: string;
  domain: string;
  businessModel: string;
  buyerICP: string;
  initialWedge: string;
}

/** Shape returned by POST /api/analyze (already normalized server-side). */
export interface AnalyzeResponse {
  summary: string;
  metadata: IdeaMetadataProposal;
  /** Anonymised public founding-team profile ("" when no background given). */
  founderProfile: string;
  gates: Record<GateId, { value: "Y" | "N" | "UNSURE"; rationale: string }>;
  scores: Record<CriterionId, { score: number; rationale: string }>;
  confidence: 0.5 | 0.75 | 1.0;
  confidenceRationale: string;
  validationTest30d: string;
  needsFounderConfirmation: GateId[];
  provider: Provider;
  model: string;
  /** Number of live web searches the model ran during the analysis. */
  webSearches: number;
}

/** Shape returned by POST /api/analyze with mode "metadata" ("Add only" flow). */
export interface AnalyzeMetadataResponse {
  metadata: IdeaMetadataProposal;
  /** Anonymised public founding-team profile ("" when no background given). */
  founderProfile: string;
  /** The description rewritten in better detail from the clarification Q&A. */
  refinedDescription: string;
  provider: Provider;
  model: string;
}

/** One clarifying question with click-to-answer choices. */
export interface ClarifyQuestion {
  question: string;
  /** Suggested answers; empty → the UI shows a free-text field only. */
  options: string[];
}

/** Shape returned by POST /api/clarify. */
export interface ClarifyResponse {
  questions: ClarifyQuestion[];
}
