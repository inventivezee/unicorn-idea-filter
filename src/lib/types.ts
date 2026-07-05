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

// ---------------------------------------------------------------------------
// Cash Cow Filter — a second scoring instrument on the same idea. It asks
// "can this produce $20M+ EBITDA/year with durable enterprise value?" where
// the unicorn filter asks "can this be venture-scale / category-defining?".
// Ideas are shared between filters; gates/scores/AI are per-filter.
// ---------------------------------------------------------------------------

export const CC_CRITERION_IDS = [
  "cc_pain",
  "cc_wtp",
  "cc_reach",
  "cc_speed",
  "cc_gm",
  "cc_ebitda",
  "cc_fcf",
  "cc_control",
  "cc_dist",
  "cc_retention",
  "cc_pricing",
  "cc_ops",
  "cc_capital",
  "cc_moat",
  "cc_exit",
  "cc_fmf",
  "cc_impact",
  "cc_transfer",
] as const;

export type CcCriterionId = (typeof CC_CRITERION_IDS)[number];

export const CC_GATE_IDS = [
  "cg_pain",
  "cg_buyer",
  "cg_path20",
  "cg_control",
  "cg_margin",
  "cg_fcf",
  "cg_engine",
  "cg_conc",
  "cg_ai",
  "cg_legal",
  "cg_impact",
] as const;

export type CcGateId = (typeof CC_GATE_IDS)[number];

/** Which scoring instrument the UI is currently showing. */
export type FilterMode = "unicorn" | "cashcow";

export interface CashCowAIAnalysis {
  summary: string;
  gateRationales: Partial<Record<CcGateId, string>>;
  scoreRationales: Partial<Record<CcCriterionId, string>>;
  confidenceRationale: string;
  needsFounderConfirmation: CcGateId[];
  provider: Provider;
  model: string;
  analyzedAt: string;
  webSearches?: number;
}

/** The Cash Cow Filter's per-idea scoring block (absent until first used). */
export interface CashCowBlock {
  gates: Record<CcGateId, GateValue>;
  scores: Record<CcCriterionId, number | null>;
  confidence: Confidence;
  validationTest30d: string;
  ai?: CashCowAIAnalysis | null;
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
  /** Cash Cow Filter scoring (independent of the unicorn fields above). */
  cashcow?: CashCowBlock;
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
  /** Active scoring instrument (unicorn = venture-scale, cashcow = EBITDA). */
  filterMode: FilterMode;
}

/** Coerce arbitrary input into a valid CashCowBlock, or undefined if empty. */
export function normalizeCashCow(value: unknown): CashCowBlock | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Partial<CashCowBlock> & { ai?: unknown };
  const gates = {} as Record<CcGateId, GateValue>;
  for (const id of CC_GATE_IDS) {
    const v = (raw.gates as Record<string, unknown> | undefined)?.[id];
    gates[id] = v === "Y" || v === "N" ? v : null;
  }
  const scores = {} as Record<CcCriterionId, number | null>;
  for (const id of CC_CRITERION_IDS) {
    const v = (raw.scores as Record<string, unknown> | undefined)?.[id];
    scores[id] =
      typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 5
        ? v
        : null;
  }
  const confidence =
    raw.confidence === 0.5 || raw.confidence === 0.75 || raw.confidence === 1.0
      ? raw.confidence
      : null;
  const validationTest30d =
    typeof raw.validationTest30d === "string" ? raw.validationTest30d : "";
  let ai: CashCowAIAnalysis | null = null;
  if (raw.ai && typeof raw.ai === "object" && !Array.isArray(raw.ai)) {
    const a = raw.ai as Partial<CashCowAIAnalysis>;
    if (typeof a.summary === "string") {
      ai = {
        summary: a.summary,
        gateRationales:
          a.gateRationales && typeof a.gateRationales === "object"
            ? (a.gateRationales as Partial<Record<CcGateId, string>>)
            : {},
        scoreRationales:
          a.scoreRationales && typeof a.scoreRationales === "object"
            ? (a.scoreRationales as Partial<Record<CcCriterionId, string>>)
            : {},
        confidenceRationale:
          typeof a.confidenceRationale === "string" ? a.confidenceRationale : "",
        needsFounderConfirmation: Array.isArray(a.needsFounderConfirmation)
          ? a.needsFounderConfirmation.filter((g): g is CcGateId =>
              (CC_GATE_IDS as readonly string[]).includes(g as string),
            )
          : [],
        provider: a.provider === "openai" ? "openai" : "anthropic",
        model: typeof a.model === "string" ? a.model : "",
        analyzedAt:
          typeof a.analyzedAt === "string"
            ? a.analyzedAt
            : new Date().toISOString(),
        ...(typeof a.webSearches === "number"
          ? { webSearches: a.webSearches }
          : {}),
      };
    }
  }
  const block: CashCowBlock = { gates, scores, confidence, validationTest30d };
  if (ai) block.ai = ai;
  // Treat a fully-empty block as absent so untouched ideas stay lean.
  const hasContent =
    ai !== null ||
    confidence !== null ||
    validationTest30d.trim() !== "" ||
    CC_GATE_IDS.some((id) => gates[id] !== null) ||
    CC_CRITERION_IDS.some((id) => scores[id] !== null);
  return hasContent ? block : undefined;
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

/** Shape returned by POST /api/analyze with filter "cashcow". */
export interface CcAnalyzeResponse {
  summary: string;
  metadata: IdeaMetadataProposal;
  founderProfile: string;
  gates: Record<CcGateId, { value: "Y" | "N" | "UNSURE"; rationale: string }>;
  scores: Record<CcCriterionId, { score: number; rationale: string }>;
  confidence: 0.5 | 0.75 | 1.0;
  confidenceRationale: string;
  validationTest30d: string;
  needsFounderConfirmation: CcGateId[];
  provider: Provider;
  model: string;
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
