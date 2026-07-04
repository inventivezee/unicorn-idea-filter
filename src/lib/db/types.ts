// Database row shapes and mappers between Postgres rows (snake_case) and the
// app's Idea type. The mappers are the single place the two shapes meet.
import { DEFAULT_WEIGHTS } from "../criteria";
import { emptyGates, emptyScores, newIdea } from "../defaults";
import { rawScore } from "../engine";
import { CRITERION_IDS, GATE_IDS } from "../types";
import type { AIAnalysis, CoFounder, Idea } from "../types";

export interface IdeaRow {
  id: string;
  owner_id: string | null;
  anon_key: string | null;
  name: string;
  domain: string;
  business_model: string;
  buyer_icp: string;
  initial_wedge: string;
  thesis_notes: string;
  gates: Record<string, unknown>;
  scores: Record<string, unknown>;
  confidence: number | null;
  validation_test_30d: string;
  top_risk_override_1: string | null;
  top_risk_override_2: string | null;
  ai: AIAnalysis | null;
  ai_summary: string;
  is_private: boolean;
  published: boolean;
  created_at: string;
  updated_at: string;
}

/** Row shape of the public_ideas view — the only publicly visible columns. */
export interface PublicIdeaRow {
  id: string;
  name: string;
  domain: string;
  business_model: string;
  buyer_icp: string;
  initial_wedge: string;
  thesis_notes: string;
  gates: Record<string, unknown>;
  scores: Record<string, unknown>;
  confidence: number | null;
  raw_score: number | null;
  ai_summary: string;
  author_handle: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProfileRow {
  id: string;
  email: string | null;
  display_name: string;
  show_handle: boolean;
  founder_background: string;
  co_founders: CoFounder[];
  prefs: Record<string, unknown>;
  is_admin: boolean;
  stripe_customer_id: string | null;
  subscription_status: string;
  subscription_period_end: string | null;
  analyses_used: number;
  analyses_reset_at: string;
  created_at: string;
  updated_at: string;
}

/** Convert a DB row into a normalized app Idea (reusing newIdea's coercions). */
export function rowToIdea(row: IdeaRow): Idea & {
  isPrivate: boolean;
  published: boolean;
} {
  const idea = newIdea({
    id: row.id,
    name: row.name ?? "",
    domain: row.domain ?? "",
    businessModel: row.business_model ?? "",
    buyerICP: row.buyer_icp ?? "",
    initialWedge: row.initial_wedge ?? "",
    thesisNotes: row.thesis_notes ?? "",
    confidence:
      row.confidence === 0.5 || row.confidence === 0.75 || row.confidence === 1.0
        ? row.confidence
        : null,
    validationTest30d: row.validation_test_30d ?? "",
    ai: row.ai ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
  if (typeof row.top_risk_override_1 === "string") {
    idea.topRiskOverride1 = row.top_risk_override_1;
  }
  if (typeof row.top_risk_override_2 === "string") {
    idea.topRiskOverride2 = row.top_risk_override_2;
  }
  const gates = emptyGates();
  for (const id of GATE_IDS) {
    const v = row.gates?.[id];
    if (v === "Y" || v === "N") gates[id] = v;
  }
  idea.gates = gates;
  const scores = emptyScores();
  for (const id of CRITERION_IDS) {
    const v = row.scores?.[id];
    if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 5) {
      scores[id] = v;
    }
  }
  idea.scores = scores;
  return Object.assign(idea, {
    isPrivate: row.is_private === true,
    published: row.published === true,
  });
}

/** Fields a client may write; everything else is server-controlled. */
export function ideaToWritableRow(idea: Partial<Idea>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (idea.name !== undefined) row.name = idea.name;
  if (idea.domain !== undefined) row.domain = idea.domain;
  if (idea.businessModel !== undefined) row.business_model = idea.businessModel;
  if (idea.buyerICP !== undefined) row.buyer_icp = idea.buyerICP;
  if (idea.initialWedge !== undefined) row.initial_wedge = idea.initialWedge;
  if (idea.thesisNotes !== undefined) row.thesis_notes = idea.thesisNotes;
  if (idea.gates !== undefined) row.gates = idea.gates;
  if (idea.scores !== undefined) row.scores = idea.scores;
  if (idea.confidence !== undefined) row.confidence = idea.confidence;
  if (idea.validationTest30d !== undefined) {
    row.validation_test_30d = idea.validationTest30d;
  }
  if ("topRiskOverride1" in idea) {
    row.top_risk_override_1 = idea.topRiskOverride1 ?? null;
  }
  if ("topRiskOverride2" in idea) {
    row.top_risk_override_2 = idea.topRiskOverride2 ?? null;
  }
  if (idea.ai !== undefined) {
    row.ai = idea.ai;
    row.ai_summary = idea.ai?.summary ?? "";
  }
  return row;
}

/** Raw score under DEFAULT weights, for public-feed ranking. Null unless fully scored. */
export function computeDefaultRawScore(
  scores: Record<string, unknown>,
): number | null {
  const normalized = emptyScores();
  for (const id of CRITERION_IDS) {
    const v = scores?.[id];
    if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 5) {
      normalized[id] = v;
    }
  }
  return rawScore(normalized, DEFAULT_WEIGHTS);
}

/** An idea publishes once it carries any score, any gate answer, or an AI analysis. */
export function computePublished(row: {
  gates: Record<string, unknown>;
  scores: Record<string, unknown>;
  ai: unknown;
}): boolean {
  const hasScore = CRITERION_IDS.some(
    (id) => typeof row.scores?.[id] === "number",
  );
  const hasGate = GATE_IDS.some(
    (id) => row.gates?.[id] === "Y" || row.gates?.[id] === "N",
  );
  return hasScore || hasGate || Boolean(row.ai);
}
