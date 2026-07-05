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
  /**
   * Which scoring instrument the question was asked for: "unicorn",
   * "cashcow", or "custom:<filterId>" for founder-designed filters. Each
   * instrument asks its own questions, so analyzing in one with no tagged
   * clarifications triggers a fresh (skippable) round. Untagged legacy
   * entries satisfy NO instrument — they predate tagging.
   */
  filter?: string;
}

/** Valid clarification tags: the two built-ins or a custom filter key. */
export function isValidFilterTag(v: unknown): v is string {
  return (
    v === "unicorn" ||
    v === "cashcow" ||
    (typeof v === "string" && /^custom:[A-Za-z0-9_-]{1,64}$/.test(v))
  );
}

/** Does the idea already have clarifying answers for this instrument? */
export function hasClarificationsFor(
  clarifications: Clarification[] | undefined,
  filter: string,
): boolean {
  // Mirrors what the prompt/db layers actually keep: entries need BOTH a
  // question and an answer to count (answer-only rows are dropped by them).
  return (clarifications ?? []).some(
    (c) =>
      c.filter === filter &&
      c.question.trim() !== "" &&
      c.answer.trim() !== "",
  );
}

/**
 * Legacy migration: ideas created before clarifications became a structured,
 * separately-fed field had their Q&A appended into the description by the old
 * QuickAdd flow (a trailing "\n\nClarifications:\n Q:… A:…" block). Now that the
 * structured clarifications feed the prompt on their own, that suffix would
 * double-count. Strip it when the idea already carries structured clarifications.
 */
const LEGACY_CLARIFICATION_MARKER = "\n\nClarifications:\n";
export function stripLegacyClarificationsSuffix(
  thesisNotes: string,
  hasClarifications: boolean,
): string {
  if (!hasClarifications) return thesisNotes;
  const idx = thesisNotes.lastIndexOf(LEGACY_CLARIFICATION_MARKER);
  return idx === -1 ? thesisNotes : thesisNotes.slice(0, idx);
}

/** Coerce arbitrary input into a clean, capped Clarification[] (DB/local/import). */
export function normalizeClarifications(value: unknown): Clarification[] {
  if (!Array.isArray(value)) return [];
  const out: Clarification[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const { question, answer, filter } = raw as {
      question?: unknown;
      answer?: unknown;
      filter?: unknown;
    };
    if (typeof question !== "string" || !question.trim()) continue;
    out.push({
      question: question.trim().slice(0, 300),
      // Multi-select answers concatenate several detailed options, so allow room.
      answer: typeof answer === "string" ? answer.trim().slice(0, 1200) : "",
      ...(isValidFilterTag(filter) ? { filter } : {}),
    });
  }
  // Cap at 20, preferring answered entries (newly answered pre-analysis Q&A
  // arrives last and must not be the part that gets truncated).
  if (out.length > 20) {
    return [
      ...out.filter((c) => c.answer !== ""),
      ...out.filter((c) => c.answer === ""),
    ].slice(0, 20);
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
export type FilterMode = "unicorn" | "cashcow" | "custom";

// ---------------------------------------------------------------------------
// Custom filters — founder-designed instruments ("I want $1M/yr and a good
// life"). The AI designs gates/criteria/weights from the founder's stated
// goals; ideas scored with a custom filter are NEVER published publicly
// (admin can still see them). A founder can keep several.
// ---------------------------------------------------------------------------

export interface CustomFilterInputs {
  /** Target net profit per year, in USD. */
  netProfitTarget: number;
  /** Hours/day the founder wants to work (UI nudges kindly below 8). */
  hoursPerDay: number;
  /** Years they're willing to spend building. */
  yearsToBuild: number;
  /** Capital they can invest, free-form (e.g. "$50k", "none"). */
  capitalAvailable: string;
  /** Max team size they want, free-form (e.g. "solo", "2-3"). */
  maxTeamSize: string;
  /** Do they ever want to sell the business? */
  wantsToSell: "yes" | "no" | "maybe";
  /** Everything else that matters to them, free text. */
  otherQualities: string;
}

export interface CustomGateDef {
  id: string;
  label: string;
  yMeans: string;
  nMeans: string;
}

export interface CustomCriterionDef {
  id: string;
  label: string;
  weight: number;
  anchor0: string;
  anchor3: string;
  anchor5: string;
}

export interface CustomFilterSpec {
  id: string;
  name: string;
  /** The instrument's core question, e.g. "Can this reach $1M/yr net profit
   *  within 4 years at ~8 hours/day, solo?" */
  question: string;
  inputs: CustomFilterInputs;
  gates: CustomGateDef[];
  criteria: CustomCriterionDef[];
  /** Bumped on regenerate; idea blocks record the version they scored under. */
  version: number;
  createdAt: string;
}

/** Compact snapshot stored with each scored idea so old verdicts stay
 *  renderable after the filter is regenerated or deleted. */
export interface CustomSpecSnapshot {
  name: string;
  question: string;
  version: number;
  gates: { id: string; label: string }[];
  criteria: { id: string; label: string; weight: number }[];
}

export interface CustomAIAnalysis {
  summary: string;
  gateRationales: Record<string, string>;
  scoreRationales: Record<string, string>;
  confidenceRationale: string;
  needsFounderConfirmation: string[];
  provider: Provider;
  model: string;
  analyzedAt: string;
  webSearches?: number;
}

/** One custom filter's verdict block on an idea (keyed by filter id). */
export interface CustomBlock {
  gates: Record<string, GateValue>;
  scores: Record<string, number | null>;
  confidence: Confidence;
  validationTest30d: string;
  ai?: CustomAIAnalysis | null;
  snapshot: CustomSpecSnapshot;
}

const MAX_CUSTOM_GATES = 9;
const MAX_CUSTOM_CRITERIA = 14;

function cleanStr(v: unknown, max: number, fallback = ""): string {
  return typeof v === "string" ? v.trim().slice(0, max) : fallback;
}

/** Coerce arbitrary input into a valid CustomFilterSpec, or null. */
export function normalizeCustomFilterSpec(
  value: unknown,
): CustomFilterSpec | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const id = cleanStr(raw.id, 64);
  const name = cleanStr(raw.name, 80);
  const question = cleanStr(raw.question, 300);
  if (!id || !name || !question) return null;

  const ri = (raw.inputs ?? {}) as Record<string, unknown>;
  const num = (v: unknown, lo: number, hi: number, fb: number) =>
    typeof v === "number" && Number.isFinite(v)
      ? Math.min(hi, Math.max(lo, v))
      : fb;
  const inputs: CustomFilterInputs = {
    netProfitTarget: num(ri.netProfitTarget, 0, 1e9, 0),
    hoursPerDay: num(ri.hoursPerDay, 1, 24, 8),
    yearsToBuild: num(ri.yearsToBuild, 0.5, 50, 5),
    capitalAvailable: cleanStr(ri.capitalAvailable, 200),
    maxTeamSize: cleanStr(ri.maxTeamSize, 200),
    wantsToSell:
      ri.wantsToSell === "yes" || ri.wantsToSell === "no" ? ri.wantsToSell : "maybe",
    otherQualities: cleanStr(ri.otherQualities, 2000),
  };

  const gates: CustomGateDef[] = (Array.isArray(raw.gates) ? raw.gates : [])
    .map((g) => {
      const r = (g ?? {}) as Record<string, unknown>;
      return {
        id: "",
        label: cleanStr(r.label, 160),
        yMeans: cleanStr(r.yMeans, 400),
        nMeans: cleanStr(r.nMeans, 400),
      };
    })
    .filter((g) => g.label)
    .slice(0, MAX_CUSTOM_GATES);
  // Re-id sequentially AFTER filtering (like criteria below) so ids always
  // match position — otherwise normalize wouldn't be idempotent and a spec
  // with a dropped blank gate would shift ids on every later re-normalize.
  gates.forEach((g, i) => {
    g.id = `g${i + 1}`;
  });

  const criteria: CustomCriterionDef[] = (
    Array.isArray(raw.criteria) ? raw.criteria : []
  )
    .map((c, i) => {
      const r = (c ?? {}) as Record<string, unknown>;
      return {
        id: `c${i + 1}`,
        label: cleanStr(r.label, 160),
        weight: num(r.weight, 0, 100, 0),
        anchor0: cleanStr(r.anchor0, 400),
        anchor3: cleanStr(r.anchor3, 400),
        anchor5: cleanStr(r.anchor5, 400),
      };
    })
    .filter((c) => c.label && c.weight > 0)
    .slice(0, MAX_CUSTOM_CRITERIA);

  if (gates.length < 3 || criteria.length < 5) return null;

  // Weights must sum to exactly 100: proportional rescale + largest-remainder.
  const total = criteria.reduce((sum, c) => sum + c.weight, 0);
  if (total <= 0) return null;
  const scaled = criteria.map((c) => (c.weight / total) * 100);
  const floors = scaled.map(Math.floor);
  let remainder = 100 - floors.reduce((a, b) => a + b, 0);
  const order = scaled
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  for (const { i } of order) {
    if (remainder <= 0) break;
    floors[i] += 1;
    remainder -= 1;
  }
  criteria.forEach((c, i) => {
    c.weight = floors[i];
  });
  // Zero-weight criteria after rounding get dropped (weightless = meaningless).
  const finalCriteria = criteria.filter((c) => c.weight > 0);
  if (finalCriteria.length < 5) return null;
  // Re-id sequentially so ids always match position.
  finalCriteria.forEach((c, i) => {
    c.id = `c${i + 1}`;
  });

  const version =
    typeof raw.version === "number" && Number.isInteger(raw.version) && raw.version > 0
      ? raw.version
      : 1;

  return {
    id,
    name,
    question,
    inputs,
    gates,
    criteria: finalCriteria,
    version,
    createdAt: cleanStr(raw.createdAt, 40, new Date().toISOString()),
  };
}

export function specToSnapshot(spec: CustomFilterSpec): CustomSpecSnapshot {
  return {
    name: spec.name,
    question: spec.question,
    version: spec.version,
    gates: spec.gates.map((g) => ({ id: g.id, label: g.label })),
    criteria: spec.criteria.map((c) => ({
      id: c.id,
      label: c.label,
      weight: c.weight,
    })),
  };
}

/** Coerce an idea's custom map (filterId → block) from unknown input. */
export function normalizeCustomBlocks(
  value: unknown,
): Record<string, CustomBlock> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const out: Record<string, CustomBlock> = {};
  const MAX_BLOCKS_PER_IDEA = 10; // founders keep ≤5 filters; bound the jsonb
  for (const [filterId, rawBlock] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (Object.keys(out).length >= MAX_BLOCKS_PER_IDEA) break;
    if (!filterId || filterId.length > 64) continue;
    if (!rawBlock || typeof rawBlock !== "object" || Array.isArray(rawBlock)) {
      continue;
    }
    const b = rawBlock as Record<string, unknown>;
    const snapRaw = (b.snapshot ?? {}) as Record<string, unknown>;
    const snapshot: CustomSpecSnapshot = {
      name: cleanStr(snapRaw.name, 80),
      question: cleanStr(snapRaw.question, 300),
      version:
        typeof snapRaw.version === "number" && snapRaw.version > 0
          ? snapRaw.version
          : 1,
      gates: (Array.isArray(snapRaw.gates) ? snapRaw.gates : [])
        .map((g) => {
          const r = (g ?? {}) as Record<string, unknown>;
          return { id: cleanStr(r.id, 8), label: cleanStr(r.label, 160) };
        })
        .filter((g) => g.id && g.label)
        .slice(0, MAX_CUSTOM_GATES),
      criteria: (Array.isArray(snapRaw.criteria) ? snapRaw.criteria : [])
        .map((c) => {
          const r = (c ?? {}) as Record<string, unknown>;
          return {
            id: cleanStr(r.id, 8),
            label: cleanStr(r.label, 160),
            weight:
              typeof r.weight === "number" && Number.isFinite(r.weight)
                ? r.weight
                : 0,
          };
        })
        .filter((c) => c.id && c.label)
        .slice(0, MAX_CUSTOM_CRITERIA),
    };
    if (!snapshot.name || snapshot.gates.length === 0 || snapshot.criteria.length === 0) {
      continue;
    }
    const gates: Record<string, GateValue> = {};
    for (const g of snapshot.gates) {
      const v = (b.gates as Record<string, unknown> | undefined)?.[g.id];
      gates[g.id] = v === "Y" || v === "N" ? v : null;
    }
    const scores: Record<string, number | null> = {};
    for (const c of snapshot.criteria) {
      const v = (b.scores as Record<string, unknown> | undefined)?.[c.id];
      scores[c.id] =
        typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 5
          ? v
          : null;
    }
    const confidence =
      b.confidence === 0.5 || b.confidence === 0.75 || b.confidence === 1.0
        ? b.confidence
        : null;
    let ai: CustomAIAnalysis | null = null;
    if (b.ai && typeof b.ai === "object" && !Array.isArray(b.ai)) {
      const a = b.ai as Record<string, unknown>;
      if (typeof a.summary === "string") {
        // Every field is bounded AND keyed to the snapshot's ids — this is
        // the size gate for client-written blocks on the quota-free CRUD
        // path, so nothing here may pass through uncapped.
        const strMap = (
          v: unknown,
          allowedIds: Set<string>,
        ): Record<string, string> => {
          if (!v || typeof v !== "object" || Array.isArray(v)) return {};
          const m: Record<string, string> = {};
          for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
            const id = k.slice(0, 8);
            if (typeof val === "string" && allowedIds.has(id)) {
              m[id] = val.slice(0, 2000);
            }
          }
          return m;
        };
        const gateIds = new Set(snapshot.gates.map((g) => g.id));
        const criterionIds = new Set(snapshot.criteria.map((c) => c.id));
        ai = {
          summary: a.summary.slice(0, 5000),
          gateRationales: strMap(a.gateRationales, gateIds),
          scoreRationales: strMap(a.scoreRationales, criterionIds),
          confidenceRationale: cleanStr(a.confidenceRationale, 2000),
          needsFounderConfirmation: (Array.isArray(a.needsFounderConfirmation)
            ? a.needsFounderConfirmation
            : []
          )
            .filter((g): g is string => typeof g === "string" && gateIds.has(g))
            .slice(0, MAX_CUSTOM_GATES),
          provider: a.provider === "openai" ? "openai" : "anthropic",
          model: cleanStr(a.model, 200),
          analyzedAt: cleanStr(a.analyzedAt, 40, new Date().toISOString()),
          ...(typeof a.webSearches === "number"
            ? { webSearches: a.webSearches }
            : {}),
        };
      }
    }
    const block: CustomBlock = {
      gates,
      scores,
      confidence,
      validationTest30d: cleanStr(b.validationTest30d, 5000),
      snapshot,
    };
    if (ai) block.ai = ai;
    const hasContent =
      ai !== null ||
      confidence !== null ||
      block.validationTest30d.trim() !== "" ||
      snapshot.gates.some((g) => gates[g.id] !== null) ||
      snapshot.criteria.some((c) => typeof scores[c.id] === "number");
    if (hasContent) out[filterId] = block;
  }
  return Object.keys(out).length ? out : undefined;
}

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
  /** Custom-filter verdicts, keyed by the founder's filter id. NEVER public. */
  custom?: Record<string, CustomBlock>;
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
  /** The founder's own AI-designed filters (private; admin-visible). */
  customFilters: CustomFilterSpec[];
  /** Which custom filter is active when filterMode === "custom". */
  activeCustomFilterId: string | null;
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
