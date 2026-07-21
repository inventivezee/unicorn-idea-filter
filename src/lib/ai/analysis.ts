// Shared normalization for unicorn-instrument analysis output — used by the
// interactive analyze route AND the discovery engine's autonomous scorer, so
// both surfaces validate model output with EXACTLY the same rules (moved
// verbatim from src/app/api/analyze/route.ts).
import { GATES } from "@/lib/criteria";
import { CC_FOUNDER_PERSONAL_GATES } from "@/lib/cashcow/criteria";
import {
  CC_CRITERION_IDS,
  CC_GATE_IDS,
  CRITERION_IDS,
  GATE_IDS,
  type AnalyzeResponse,
  type CcAnalyzeResponse,
  type CcGateId,
  type GateId,
  type IdeaMetadataProposal,
  type Provider,
} from "@/lib/types";

export const FOUNDER_PERSONAL_GATES = GATES.filter(
  (g) => g.founderPersonal,
).map((g) => g.id);

/** The wire shape models return for a unicorn analysis (pre-normalization). */
export interface RawAnalysis {
  summary: string;
  metadata?: Record<string, unknown>;
  founderProfile?: string;
  gates: Record<string, { value: string; rationale: string }>;
  scores: Record<string, { score: number; rationale: string }>;
  confidence: string;
  confidenceRationale: string;
  validationTest30d: string;
  needsFounderConfirmation: string[];
}

export function normalizeMetadataBlock(
  meta: Record<string, unknown> | undefined,
): IdeaMetadataProposal {
  const metaStr = (key: string) => {
    const v = meta?.[key];
    return typeof v === "string" ? v.trim() : "";
  };
  return {
    name: metaStr("name").slice(0, 80),
    domain: metaStr("domain"),
    businessModel: metaStr("businessModel"),
    buyerICP: metaStr("buyerICP"),
    initialWedge: metaStr("initialWedge"),
  };
}

export function normalizeAnalysis(
  raw: RawAnalysis,
  webSearches: number,
  provider: Provider,
  model: string,
): AnalyzeResponse {
  const gates = {} as AnalyzeResponse["gates"];
  for (const id of GATE_IDS) {
    const g = raw.gates?.[id];
    const value = g?.value === "Y" || g?.value === "N" ? g.value : "UNSURE";
    gates[id] = { value, rationale: g?.rationale ?? "" };
  }

  const scores = {} as AnalyzeResponse["scores"];
  for (const id of CRITERION_IDS) {
    const s = raw.scores?.[id];
    const score =
      typeof s?.score === "number"
        ? Math.min(5, Math.max(0, Math.round(s.score)))
        : 0;
    scores[id] = { score, rationale: s?.rationale ?? "" };
  }

  const confidence =
    raw.confidence === "1.0" ? 1.0 : raw.confidence === "0.75" ? 0.75 : 0.5;

  const needsConfirmation = new Set<GateId>(FOUNDER_PERSONAL_GATES);
  for (const id of raw.needsFounderConfirmation ?? []) {
    if ((GATE_IDS as readonly string[]).includes(id)) {
      needsConfirmation.add(id as GateId);
    }
  }
  for (const id of GATE_IDS) {
    if (gates[id].value === "UNSURE") needsConfirmation.add(id);
  }

  return {
    summary: raw.summary ?? "",
    metadata: normalizeMetadataBlock(raw.metadata),
    founderProfile:
      typeof raw.founderProfile === "string"
        ? raw.founderProfile.trim().slice(0, 600)
        : "",
    gates,
    scores,
    confidence,
    confidenceRationale: raw.confidenceRationale ?? "",
    validationTest30d: raw.validationTest30d ?? "",
    needsFounderConfirmation: [...needsConfirmation],
    provider,
    model,
    webSearches,
  };
}

/** Cash Cow normalization — the $20M EBITDA instrument's gates/criteria.
 *  Moved verbatim from the analyze route so the interactive route and the
 *  autonomous Cash Cow scorer validate output identically. */
export function normalizeCashCowAnalysis(
  raw: RawAnalysis,
  webSearches: number,
  provider: Provider,
  model: string,
): CcAnalyzeResponse {
  const gates = {} as CcAnalyzeResponse["gates"];
  for (const id of CC_GATE_IDS) {
    const g = raw.gates?.[id];
    const value = g?.value === "Y" || g?.value === "N" ? g.value : "UNSURE";
    gates[id] = { value, rationale: g?.rationale ?? "" };
  }
  const scores = {} as CcAnalyzeResponse["scores"];
  for (const id of CC_CRITERION_IDS) {
    const s = raw.scores?.[id];
    scores[id] = {
      score:
        typeof s?.score === "number"
          ? Math.min(5, Math.max(0, Math.round(s.score)))
          : 0,
      rationale: s?.rationale ?? "",
    };
  }
  const confidence =
    raw.confidence === "1.0" ? 1.0 : raw.confidence === "0.75" ? 0.75 : 0.5;
  const needsConfirmation = new Set<CcGateId>(CC_FOUNDER_PERSONAL_GATES);
  for (const id of raw.needsFounderConfirmation ?? []) {
    if ((CC_GATE_IDS as readonly string[]).includes(id)) {
      needsConfirmation.add(id as CcGateId);
    }
  }
  for (const id of CC_GATE_IDS) {
    if (gates[id].value === "UNSURE") needsConfirmation.add(id);
  }
  return {
    summary: raw.summary ?? "",
    metadata: normalizeMetadataBlock(raw.metadata),
    founderProfile:
      typeof raw.founderProfile === "string"
        ? raw.founderProfile.trim().slice(0, 600)
        : "",
    gates,
    scores,
    confidence,
    confidenceRationale: raw.confidenceRationale ?? "",
    validationTest30d: raw.validationTest30d ?? "",
    needsFounderConfirmation: [...needsConfirmation],
    provider,
    model,
    webSearches,
  };
}
