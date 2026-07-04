import { GATES } from "@/lib/criteria";
import {
  buildUserPrompt,
  METADATA_SYSTEM_PROMPT,
  SYSTEM_PROMPT,
} from "@/lib/ai/prompt";
import type { AnalyzeRequestIdea } from "@/lib/ai/prompt";
import { ANALYSIS_SCHEMA, METADATA_SCHEMA } from "@/lib/ai/schema";
import {
  callProviderJSON,
  coFoundersFromBody,
  field,
  guardRequest,
  keyMissingResponse,
  mapProviderError,
  modelFromBody,
  parseLastJSON,
  providerFromBody,
  readJsonBody,
  MAX_BACKGROUND_CHARS,
} from "@/lib/ai/server";
import { CRITERION_IDS, GATE_IDS } from "@/lib/types";
import type {
  AnalyzeMetadataResponse,
  AnalyzeResponse,
  GateId,
  IdeaMetadataProposal,
  Provider,
} from "@/lib/types";

// AI analysis with a thinking model can take a while — allow long invocations.
export const maxDuration = 300;

const FOUNDER_PERSONAL_GATES = GATES.filter((g) => g.founderPersonal).map(
  (g) => g.id,
);

interface RawAnalysis {
  summary: string;
  metadata?: Record<string, unknown>;
  gates: Record<string, { value: string; rationale: string }>;
  scores: Record<string, { score: number; rationale: string }>;
  confidence: string;
  confidenceRationale: string;
  validationTest30d: string;
  needsFounderConfirmation: string[];
}

interface RawMetadata {
  metadata?: Record<string, unknown>;
  refinedDescription?: string;
}

function normalizeMetadataBlock(
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

function normalize(
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

function isIdeaEmpty(idea: AnalyzeRequestIdea): boolean {
  return ![
    idea.name,
    idea.domain,
    idea.businessModel,
    idea.buyerICP,
    idea.initialWedge,
    idea.thesisNotes,
  ].some((f) => typeof f === "string" && f.trim().length > 0);
}

export async function POST(request: Request) {
  const guard = guardRequest(request);
  if (guard) return guard;

  const body = await readJsonBody(request);
  if (!body) {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const mode = body.mode === "metadata" ? "metadata" : "full";
  const webSearch = mode === "full" && body.webSearch !== false;
  const provider = providerFromBody(body.provider);
  const model = modelFromBody(body.model);

  if (!model) {
    return Response.json({ error: "No model selected." }, { status: 400 });
  }
  const rawIdea =
    body.idea && typeof body.idea === "object" && !Array.isArray(body.idea)
      ? (body.idea as Record<string, unknown>)
      : null;
  const idea: AnalyzeRequestIdea | null = rawIdea
    ? {
        name: field(rawIdea.name),
        domain: field(rawIdea.domain),
        businessModel: field(rawIdea.businessModel),
        buyerICP: field(rawIdea.buyerICP),
        initialWedge: field(rawIdea.initialWedge),
        thesisNotes: field(rawIdea.thesisNotes),
      }
    : null;
  if (!idea || isIdeaEmpty(idea)) {
    return Response.json(
      { error: "Describe the idea first — at minimum a name and thesis notes." },
      { status: 400 },
    );
  }
  const founderBackground = field(body.founderBackground, MAX_BACKGROUND_CHARS);
  const coFounders = coFoundersFromBody(body.coFounders);
  if (mode === "full" && !founderBackground.trim()) {
    return Response.json(
      {
        error:
          "Founder background is required before an idea can be analyzed — add it in Settings.",
      },
      { status: 400 },
    );
  }

  const missing = keyMissingResponse(provider);
  if (missing) return missing;

  const userPrompt = buildUserPrompt(idea, founderBackground, coFounders);

  try {
    if (mode === "metadata") {
      const result = await callProviderJSON({
        provider,
        model,
        system: METADATA_SYSTEM_PROMPT,
        prompt: userPrompt,
        schemaName: "idea_metadata",
        schema: METADATA_SCHEMA as unknown as Record<string, unknown>,
        webSearch: false,
        speed: "fast",
      });
      const raw = parseLastJSON<RawMetadata>(result.texts);
      const response: AnalyzeMetadataResponse = {
        metadata: normalizeMetadataBlock(raw.metadata),
        refinedDescription:
          typeof raw.refinedDescription === "string"
            ? raw.refinedDescription.trim()
            : "",
        provider,
        model,
      };
      return Response.json(response);
    }

    const result = await callProviderJSON({
      provider,
      model,
      system: SYSTEM_PROMPT,
      prompt: userPrompt,
      schemaName: "idea_analysis",
      schema: ANALYSIS_SCHEMA as unknown as Record<string, unknown>,
      webSearch,
      speed: "quality",
    });
    const raw = parseLastJSON<RawAnalysis>(result.texts);
    return Response.json(normalize(raw, result.webSearches, provider, model));
  } catch (err) {
    return mapProviderError(err, model);
  }
}
