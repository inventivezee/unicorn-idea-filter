import { CC_FOUNDER_PERSONAL_GATES } from "@/lib/cashcow/criteria";
import { GATES } from "@/lib/criteria";
import {
  buildCashCowSystemPrompt,
  buildCustomSystemPrompt,
  buildSystemPrompt,
  buildUserPrompt,
  METADATA_SYSTEM_PROMPT,
} from "@/lib/ai/prompt";
import type { AnalyzeRequestIdea } from "@/lib/ai/prompt";
import {
  ANALYSIS_SCHEMA,
  buildCustomAnalysisSchema,
  CC_ANALYSIS_SCHEMA,
  METADATA_SCHEMA,
} from "@/lib/ai/schema";
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
import {
  applyAnalysisToIdea,
  applyCashCowToIdea,
  applyCustomToIdea,
} from "@/lib/db/ideas";
import {
  ANON_ANALYSES_PER_DAY,
  FREE_ANALYSES_PER_MONTH,
  isPremiumModel,
  STANDARD_WEB_SEARCH_CAP,
} from "@/lib/entitlements";
import {
  adminClient,
  anonKeyFromBody,
  cloudConfigured,
  requestTelemetry,
  resolveCaller,
} from "@/lib/supabase/server";
import {
  CC_CRITERION_IDS,
  CC_GATE_IDS,
  CRITERION_IDS,
  GATE_IDS,
  normalizeClarifications,
  normalizeCustomFilterSpec,
  specToSnapshot,
} from "@/lib/types";
import type {
  AnalyzeMetadataResponse,
  AnalyzeResponse,
  CcAnalyzeResponse,
  CcGateId,
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
  founderProfile?: string;
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
  founderProfile?: string;
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

/** Normalize a raw cash-cow analysis (same RawAnalysis wire shape, cc ids). */
function normalizeCc(
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
  // Which scoring instrument: unicorn, cashcow, or a founder-designed custom
  // filter (spec supplied by the client, re-validated here).
  const filter =
    body.filter === "cashcow"
      ? "cashcow"
      : body.filter === "custom"
        ? "custom"
        : "unicorn";
  const customSpec =
    filter === "custom" ? normalizeCustomFilterSpec(body.customSpec) : null;
  if (filter === "custom" && !customSpec) {
    return Response.json(
      { error: "Invalid or missing custom filter definition." },
      { status: 400 },
    );
  }
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
  // The founder's clarifying Q&A feeds the analysis as authoritative input.
  const clarifications = normalizeClarifications(body.clarifications);
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

  // Cloud enforcement: premium models, quotas, telemetry, persistence.
  const anonKey = anonKeyFromBody(body.anonKey);
  const ideaId = typeof body.ideaId === "string" ? body.ideaId : null;
  let logAnalysis: ((webSearches: number) => Promise<void>) | null = null;
  let refundQuota: (() => Promise<void>) | null = null;
  let persistTo: string | null = null;
  // Local-only deployments run on the owner's keys — premium tier applies.
  let tier: "premium" | "standard" = "premium";

  if (cloudConfigured()) {
    const caller = await resolveCaller();
    const subscribed = caller.subscribed || caller.isAdmin;
    tier = subscribed ? "premium" : "standard";

    if (isPremiumModel(model) && !subscribed) {
      return Response.json(
        {
          error:
            "That model is available to subscribers — upgrade for $19/month in Settings, or pick a non-premium model.",
          upgrade: true,
        },
        { status: 402 },
      );
    }

    if (mode === "full" && !subscribed) {
      const admin = adminClient();
      if (caller.user) {
        const { data: allowed } = await admin.rpc("consume_free_analysis", {
          p_user: caller.user.id,
          p_limit: FREE_ANALYSES_PER_MONTH,
        });
        if (!allowed) {
          return Response.json(
            {
              error: `You've used all ${FREE_ANALYSES_PER_MONTH} free analyses this month — upgrade for unlimited analyses and premium models.`,
              upgrade: true,
            },
            { status: 402 },
          );
        }
        const userId = caller.user.id;
        refundQuota = async () => {
          await admin.rpc("refund_free_analysis", { p_user: userId });
        };
      } else {
        if (!anonKey) {
          return Response.json(
            { error: "Missing device identity — reload and try again." },
            { status: 400 },
          );
        }
        const telemetry = requestTelemetry(request);
        const { data: allowed } = await admin.rpc("consume_anon_analysis", {
          p_ip: telemetry.ip,
          p_device: anonKey,
          p_limit: ANON_ANALYSES_PER_DAY,
        });
        if (!allowed) {
          return Response.json(
            {
              error: `Anonymous visitors get ${ANON_ANALYSES_PER_DAY} analyses per day — sign in for ${FREE_ANALYSES_PER_MONTH} free per month, or subscribe for unlimited.`,
              upgrade: true,
            },
            { status: 402 },
          );
        }
        refundQuota = async () => {
          await admin.rpc("refund_anon_analysis", {
            p_ip: telemetry.ip,
            p_device: anonKey,
          });
        };
      }
    }

    // Verify the idea row belongs to this caller before promising to persist.
    // The quick-add flow fires this request in parallel with the row's own
    // POST insert, so retry briefly when the row hasn't landed yet.
    if (ideaId) {
      const admin = adminClient();
      for (let attempt = 0; attempt < 4 && !persistTo; attempt++) {
        if (attempt > 0) {
          await new Promise((resolve) => setTimeout(resolve, 700));
        }
        const { data: row } = await admin
          .from("ideas")
          .select("id, owner_id, anon_key")
          .eq("id", ideaId)
          .maybeSingle<{ id: string; owner_id: string | null; anon_key: string | null }>();
        if (!row) continue;
        const owns =
          caller.isAdmin ||
          (caller.user
            ? row.owner_id === caller.user.id
            : row.owner_id === null && row.anon_key === anonKey);
        if (owns) persistTo = ideaId;
        break;
      }
    }

    const admin = adminClient();
    const telemetry = requestTelemetry(request);
    logAnalysis = async (webSearches: number) => {
      await admin.from("submission_logs").insert({
        idea_id: persistTo,
        user_id: caller.user?.id ?? null,
        anon_key: caller.user ? null : anonKey,
        action:
          mode === "metadata"
            ? "fill"
            : filter === "cashcow"
              ? "analyze_cashcow"
              : filter === "custom"
                ? "analyze_custom"
                : "analyze",
        ...telemetry,
        founder_background_snapshot: founderBackground || null,
        provider,
        model,
        web_searches: webSearches,
      });
    };
  }

  const userPrompt = buildUserPrompt(
    idea,
    founderBackground,
    coFounders,
    clarifications,
  );

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
        tier,
      });
      const raw = parseLastJSON<RawMetadata>(result.texts);
      const response: AnalyzeMetadataResponse = {
        metadata: normalizeMetadataBlock(raw.metadata),
        refinedDescription:
          typeof raw.refinedDescription === "string"
            ? raw.refinedDescription.trim()
            : "",
        founderProfile:
          typeof raw.founderProfile === "string"
            ? raw.founderProfile.trim().slice(0, 600)
            : "",
        provider,
        model,
      };
      if (persistTo) {
        await applyAnalysisToIdea(adminClient(), persistTo, {
          metadata: response.metadata as unknown as Record<string, string>,
          founderProfile: response.founderProfile,
        });
      }
      await logAnalysis?.(0);
      return Response.json(response);
    }

    // Subscribers/admins (premium) search uncapped; free tier is budgeted.
    const searchBudget = tier === "premium" ? null : STANDARD_WEB_SEARCH_CAP;

    if (filter === "custom" && customSpec) {
      const snapshot = specToSnapshot(customSpec);
      const result = await callProviderJSON({
        provider,
        model,
        system: buildCustomSystemPrompt(customSpec, searchBudget),
        prompt: userPrompt,
        schemaName: "custom_analysis",
        schema: buildCustomAnalysisSchema(customSpec),
        webSearch,
        speed: "quality",
        tier,
      });
      const raw = parseLastJSON<RawAnalysis>(result.texts);
      const gates: Record<string, { value: "Y" | "N" | "UNSURE"; rationale: string }> = {};
      for (const g of customSpec.gates) {
        const v = raw.gates?.[g.id];
        gates[g.id] = {
          value: v?.value === "Y" || v?.value === "N" ? v.value : "UNSURE",
          rationale: v?.rationale ?? "",
        };
      }
      const scores: Record<string, { score: number; rationale: string }> = {};
      for (const c of customSpec.criteria) {
        const sc = raw.scores?.[c.id];
        scores[c.id] = {
          score:
            typeof sc?.score === "number"
              ? Math.min(5, Math.max(0, Math.round(sc.score)))
              : 0,
          rationale: sc?.rationale ?? "",
        };
      }
      const needsConfirmation = new Set<string>();
      for (const g of customSpec.gates) {
        if (gates[g.id].value === "UNSURE") needsConfirmation.add(g.id);
      }
      const confidence =
        raw.confidence === "1.0" ? 1.0 : raw.confidence === "0.75" ? 0.75 : 0.5;
      const response = {
        summary: raw.summary ?? "",
        metadata: normalizeMetadataBlock(raw.metadata),
        founderProfile:
          typeof raw.founderProfile === "string"
            ? raw.founderProfile.trim().slice(0, 600)
            : "",
        gates,
        scores,
        confidence: confidence as 0.5 | 0.75 | 1.0,
        confidenceRationale: raw.confidenceRationale ?? "",
        validationTest30d: raw.validationTest30d ?? "",
        needsFounderConfirmation: [...needsConfirmation],
        provider,
        model,
        webSearches: result.webSearches,
      };
      if (persistTo) {
        await applyCustomToIdea(adminClient(), persistTo, customSpec.id, snapshot, {
          ...response,
          metadata: response.metadata as unknown as Record<string, string>,
        });
      }
      await logAnalysis?.(response.webSearches);
      refundQuota = null; // result delivered — the analysis is spent fairly
      return Response.json({ ...response, filterId: customSpec.id, snapshot });
    }

    if (filter === "cashcow") {
      const result = await callProviderJSON({
        provider,
        model,
        system: buildCashCowSystemPrompt(searchBudget),
        prompt: userPrompt,
        schemaName: "cashcow_analysis",
        schema: CC_ANALYSIS_SCHEMA as unknown as Record<string, unknown>,
        webSearch,
        speed: "quality",
        tier,
      });
      const raw = parseLastJSON<RawAnalysis>(result.texts);
      const response = normalizeCc(raw, result.webSearches, provider, model);
      if (persistTo) {
        await applyCashCowToIdea(adminClient(), persistTo, response);
      }
      await logAnalysis?.(response.webSearches);
      refundQuota = null; // result delivered — the analysis is spent fairly
      return Response.json(response);
    }

    const result = await callProviderJSON({
      provider,
      model,
      system: buildSystemPrompt(searchBudget),
      prompt: userPrompt,
      schemaName: "idea_analysis",
      schema: ANALYSIS_SCHEMA as unknown as Record<string, unknown>,
      webSearch,
      speed: "quality",
      tier,
    });
    const raw = parseLastJSON<RawAnalysis>(result.texts);
    const response = normalize(raw, result.webSearches, provider, model);
    if (persistTo) {
      await applyAnalysisToIdea(adminClient(), persistTo, {
        metadata: response.metadata as unknown as Record<string, string>,
        founderProfile: response.founderProfile,
        gates: response.gates,
        scores: response.scores,
        confidence: response.confidence,
        validationTest30d: response.validationTest30d,
        ai: {
          summary: response.summary,
          gateRationales: Object.fromEntries(
            Object.entries(response.gates).map(([k, v]) => [k, v.rationale]),
          ),
          scoreRationales: Object.fromEntries(
            Object.entries(response.scores).map(([k, v]) => [k, v.rationale]),
          ),
          confidenceRationale: response.confidenceRationale,
          needsFounderConfirmation: response.needsFounderConfirmation,
          provider: response.provider,
          model: response.model,
          analyzedAt: new Date().toISOString(),
          webSearches: response.webSearches,
        },
        aiSummary: response.summary,
      });
    }
    await logAnalysis?.(response.webSearches);
    refundQuota = null; // result delivered — the analysis is spent fairly
    return Response.json(response);
  } catch (err) {
    // Don't burn free-tier quota on provider failures.
    await refundQuota?.().catch(() => {});
    return mapProviderError(err, model);
  }
}
