// Admin: manually run the full analysis on any idea. Uses the owner's stored
// founder background when available (or the latest anonymous snapshot), and
// persists results with the standard fill-blanks merge. Quota-exempt.
import {
  buildCashCowSystemPrompt,
  buildSystemPrompt,
  buildUserPrompt,
} from "@/lib/ai/prompt";
import { ANALYSIS_SCHEMA, CC_ANALYSIS_SCHEMA } from "@/lib/ai/schema";
import {
  callProviderJSON,
  keyMissingResponse,
  mapProviderError,
  parseLastJSON,
  readJsonBody,
} from "@/lib/ai/server";
import { applyAnalysisToIdea, applyCashCowToIdea } from "@/lib/db/ideas";
import type { IdeaRow, ProfileRow } from "@/lib/db/types";
import {
  adminClient,
  cloudConfigured,
  requestTelemetry,
  resolveCaller,
} from "@/lib/supabase/server";
import { CC_FOUNDER_PERSONAL_GATES } from "@/lib/cashcow/criteria";
import { GATES } from "@/lib/criteria";
import {
  CC_CRITERION_IDS,
  CC_GATE_IDS,
  CRITERION_IDS,
  GATE_IDS,
  normalizeClarifications,
} from "@/lib/types";
import type {
  CcAnalyzeResponse,
  CcGateId,
  CoFounder,
  GateId,
} from "@/lib/types";

export const maxDuration = 300;

const DEFAULT_ADMIN_MODEL = "claude-opus-4-8";

interface RawAnalysis {
  summary: string;
  metadata?: Record<string, string>;
  founderProfile?: string;
  gates: Record<string, { value: string; rationale: string }>;
  scores: Record<string, { score: number; rationale: string }>;
  confidence: string;
  confidenceRationale: string;
  validationTest30d: string;
  needsFounderConfirmation: string[];
}

export async function POST(request: Request) {
  if (!cloudConfigured()) {
    return Response.json({ error: "Cloud not configured." }, { status: 503 });
  }
  const caller = await resolveCaller();
  if (!caller.isAdmin) {
    return Response.json({ error: "Admin only." }, { status: 403 });
  }
  const body = await readJsonBody(request);
  const ideaId = typeof body?.ideaId === "string" ? body.ideaId : null;
  if (!ideaId) {
    return Response.json({ error: "ideaId required." }, { status: 400 });
  }
  // Which instrument to run — the idea is analyzed EXACTLY as it stands
  // (original founder background, existing clarifications, no extra questions)
  // so an admin/mentor can show a founder how it fares on the other filter.
  const filter =
    body?.filter === "cashcow" ? ("cashcow" as const) : ("unicorn" as const);
  const model =
    typeof body?.model === "string" && body.model.trim()
      ? body.model.trim().slice(0, 200)
      : DEFAULT_ADMIN_MODEL;
  const provider = model.startsWith("gpt") ? ("openai" as const) : ("anthropic" as const);
  const missing = keyMissingResponse(provider);
  if (missing) return missing;

  const admin = adminClient();
  const { data: row } = await admin
    .from("ideas")
    .select("*")
    .eq("id", ideaId)
    .maybeSingle<IdeaRow>();
  if (!row) return Response.json({ error: "Idea not found." }, { status: 404 });

  // Best available founding-team context: owner profile, else the latest
  // anonymous snapshot logged at analysis time.
  let founderBackground = "";
  let coFounders: { name: string; background: string }[] = [];
  if (row.owner_id) {
    const { data: profile } = await admin
      .from("profiles")
      .select("founder_background, co_founders")
      .eq("id", row.owner_id)
      .maybeSingle<Pick<ProfileRow, "founder_background" | "co_founders">>();
    founderBackground = profile?.founder_background ?? "";
    coFounders = (Array.isArray(profile?.co_founders) ? profile.co_founders : [])
      .filter((c: CoFounder) => c.background?.trim())
      .map((c: CoFounder) => ({ name: c.name ?? "", background: c.background }));
  } else {
    const { data: log } = await admin
      .from("submission_logs")
      .select("founder_background_snapshot")
      .eq("idea_id", ideaId)
      .not("founder_background_snapshot", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle<{ founder_background_snapshot: string }>();
    founderBackground = log?.founder_background_snapshot ?? "";
  }

  const userPrompt = buildUserPrompt(
    {
      name: row.name,
      domain: row.domain,
      businessModel: row.business_model,
      buyerICP: row.buyer_icp,
      initialWedge: row.initial_wedge,
      thesisNotes: row.thesis_notes,
    },
    founderBackground,
    coFounders,
    normalizeClarifications(row.clarifications),
  );

  if (filter === "cashcow") {
    try {
      const result = await callProviderJSON({
        provider,
        model,
        // Admin runs premium tier — uncapped web search.
        system: buildCashCowSystemPrompt(null),
        prompt: userPrompt,
        schemaName: "cashcow_analysis",
        schema: CC_ANALYSIS_SCHEMA as unknown as Record<string, unknown>,
        webSearch: true,
        speed: "quality",
        tier: "premium",
      });
      const raw = parseLastJSON<RawAnalysis>(result.texts);

      const gates = {} as CcAnalyzeResponse["gates"];
      for (const id of CC_GATE_IDS) {
        const g = raw.gates?.[id];
        gates[id] = {
          value: g?.value === "Y" || g?.value === "N" ? g.value : "UNSURE",
          rationale: g?.rationale ?? "",
        };
      }
      const scores = {} as CcAnalyzeResponse["scores"];
      for (const id of CC_CRITERION_IDS) {
        const sc = raw.scores?.[id];
        scores[id] = {
          score:
            typeof sc?.score === "number"
              ? Math.min(5, Math.max(0, Math.round(sc.score)))
              : 0,
          rationale: sc?.rationale ?? "",
        };
      }
      const needsConfirmation = new Set<CcGateId>(CC_FOUNDER_PERSONAL_GATES);
      for (const id of CC_GATE_IDS) {
        if (gates[id].value === "UNSURE") needsConfirmation.add(id);
      }

      const response: CcAnalyzeResponse = {
        summary: raw.summary ?? "",
        metadata: {
          name: raw.metadata?.name ?? "",
          domain: raw.metadata?.domain ?? "",
          businessModel: raw.metadata?.businessModel ?? "",
          buyerICP: raw.metadata?.buyerICP ?? "",
          initialWedge: raw.metadata?.initialWedge ?? "",
        },
        founderProfile:
          typeof raw.founderProfile === "string"
            ? raw.founderProfile.trim().slice(0, 600)
            : "",
        gates,
        scores,
        confidence:
          raw.confidence === "1.0" ? 1.0 : raw.confidence === "0.75" ? 0.75 : 0.5,
        confidenceRationale: raw.confidenceRationale ?? "",
        validationTest30d: raw.validationTest30d ?? "",
        needsFounderConfirmation: [...needsConfirmation],
        provider,
        model,
        webSearches: result.webSearches,
      };
      await applyCashCowToIdea(admin, ideaId, response);

      await admin.from("submission_logs").insert({
        idea_id: ideaId,
        user_id: caller.user?.id ?? null,
        action: "admin_analyze_cashcow",
        ...requestTelemetry(request),
        provider,
        model,
        web_searches: result.webSearches,
      });

      return Response.json({ ok: true, webSearches: result.webSearches });
    } catch (err) {
      return mapProviderError(err, model);
    }
  }

  try {
    const result = await callProviderJSON({
      provider,
      model,
      // Admin runs premium tier — uncapped web search.
      system: buildSystemPrompt(null),
      prompt: userPrompt,
      schemaName: "idea_analysis",
      schema: ANALYSIS_SCHEMA as unknown as Record<string, unknown>,
      webSearch: true,
      speed: "quality",
      tier: "premium",
    });
    const raw = parseLastJSON<RawAnalysis>(result.texts);

    const gates: Record<string, { value: string; rationale: string }> = {};
    for (const id of GATE_IDS) {
      const g = raw.gates?.[id];
      gates[id] = {
        value: g?.value === "Y" || g?.value === "N" ? g.value : "UNSURE",
        rationale: g?.rationale ?? "",
      };
    }
    const scores: Record<string, { score: number; rationale: string }> = {};
    for (const id of CRITERION_IDS) {
      const s = raw.scores?.[id];
      scores[id] = {
        score:
          typeof s?.score === "number"
            ? Math.min(5, Math.max(0, Math.round(s.score)))
            : 0,
        rationale: s?.rationale ?? "",
      };
    }
    const founderPersonal = GATES.filter((g) => g.founderPersonal).map((g) => g.id);
    const needsConfirmation = new Set<GateId>(founderPersonal);
    for (const id of GATE_IDS) {
      if (gates[id].value === "UNSURE") needsConfirmation.add(id);
    }

    await applyAnalysisToIdea(admin, ideaId, {
      metadata: raw.metadata ?? {},
      founderProfile:
        typeof raw.founderProfile === "string"
          ? raw.founderProfile.trim().slice(0, 600)
          : "",
      gates,
      scores,
      confidence:
        raw.confidence === "1.0" ? 1.0 : raw.confidence === "0.75" ? 0.75 : 0.5,
      validationTest30d: raw.validationTest30d ?? "",
      ai: {
        summary: raw.summary ?? "",
        gateRationales: Object.fromEntries(
          Object.entries(gates).map(([k, v]) => [k, v.rationale]),
        ),
        scoreRationales: Object.fromEntries(
          Object.entries(scores).map(([k, v]) => [k, v.rationale]),
        ),
        confidenceRationale: raw.confidenceRationale ?? "",
        needsFounderConfirmation: [...needsConfirmation],
        provider,
        model,
        analyzedAt: new Date().toISOString(),
        webSearches: result.webSearches,
      },
      aiSummary: raw.summary ?? "",
    });

    await admin.from("submission_logs").insert({
      idea_id: ideaId,
      user_id: caller.user?.id ?? null,
      action: "admin_analyze",
      ...requestTelemetry(request),
      provider,
      model,
      web_searches: result.webSearches,
    });

    return Response.json({ ok: true, webSearches: result.webSearches });
  } catch (err) {
    return mapProviderError(err, model);
  }
}
