// Reframe generator — rescues an idea that scored poorly by proposing
// substantive mutations that attack its specific weaknesses (failed gates,
// low heavyweight scores, top risks). Works off the existing analysis, no web
// search — quota-free like the clarify/metadata helpers, but premium-gated
// and logged the same way.
import {
  buildReframePrompt,
  buildReframeSystemPrompt,
  type ReframeWeakness,
} from "@/lib/ai/prompt";
import { REFRAME_SCHEMA } from "@/lib/ai/schema";
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
import { CC_CRITERIA_BY_ID, CC_GATES_BY_ID } from "@/lib/cashcow/criteria";
import {
  ccIsFullyScored,
  ccKillerFlags,
  ccTopRisks,
  emptyCcScores,
} from "@/lib/cashcow/engine";
import { CRITERIA_BY_ID, DEFAULT_WEIGHTS, GATES_BY_ID } from "@/lib/criteria";
import type { Weights } from "@/lib/engine";
import { killerFlags, topRisks } from "@/lib/engine";
import { isPremiumModel } from "@/lib/entitlements";
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
} from "@/lib/types";
import type { CcCriterionId, CriterionId } from "@/lib/types";

export const maxDuration = 300;

function record(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/** The user's custom unicorn weights, validated — falls back to defaults. */
function weightsFromBody(value: unknown): Weights {
  const raw = record(value);
  const out = { ...DEFAULT_WEIGHTS };
  for (const id of CRITERION_IDS) {
    const v = raw[id];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1000) {
      out[id] = v;
    }
  }
  return out;
}

/** Distill the instrument's weak points from gates/scores/rationales. */
function buildWeaknesses(
  filter: "unicorn" | "cashcow" | "custom",
  gates: Record<string, unknown>,
  scores: Record<string, unknown>,
  gateRationales: Record<string, unknown>,
  scoreRationales: Record<string, unknown>,
  weights: Weights,
  customSpec?: {
    gates: { id: string; label: string; nMeans: string }[];
    criteria: { id: string; label: string; weight: number }[];
  },
): ReframeWeakness[] {
  const out: ReframeWeakness[] = [];
  // Rationales are user-supplied — cap them like every other prompt input so
  // an anonymous caller can't inflate this quota-free call to a huge prompt.
  const rationale = (m: Record<string, unknown>, id: string) =>
    typeof m[id] === "string" && (m[id] as string).trim()
      ? ` — ${(m[id] as string).trim().slice(0, 500)}`
      : "";

  if (filter === "custom" && customSpec) {
    for (const g of customSpec.gates) {
      if (gates[g.id] === "N") {
        out.push({
          label: `FAILED GATE: ${g.label}`,
          detail: `${g.nMeans}${rationale(gateRationales, g.id)}`,
        });
      }
    }
    const meanWeight = 100 / Math.max(1, customSpec.criteria.length);
    for (const c of customSpec.criteria) {
      const v = scores[c.id];
      if (typeof v === "number" && v <= 2) {
        out.push({
          label: `${c.weight >= meanWeight ? "Killer flag" : "Weak point"}: ${c.label} scored ${v}`,
          detail: `Weight ${c.weight}/100${rationale(scoreRationales, c.id)}`,
        });
      }
    }
    return out.slice(0, 10);
  }
  if (filter === "cashcow") {
    for (const id of CC_GATE_IDS) {
      if (gates[id] === "N") {
        out.push({
          label: `FAILED GATE: ${CC_GATES_BY_ID[id].label}`,
          detail: `${CC_GATES_BY_ID[id].killSignal}${rationale(gateRationales, id)}`,
        });
      }
    }
    const s = emptyCcScores();
    for (const id of CC_CRITERION_IDS) {
      const v = scores[id];
      if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 5) {
        s[id] = v;
      }
    }
    for (const id of ccKillerFlags(s)) {
      out.push({
        label: `Killer flag: ${CC_CRITERIA_BY_ID[id].label} scored ${s[id]}`,
        detail: `Heavyweight cash criterion${rationale(scoreRationales, id)}`,
      });
    }
    // Like the unicorn branch: top risks are only meaningful when fully
    // scored — on partial scoring they'd rank the few scored strengths.
    for (const r of ccIsFullyScored(s) ? ccTopRisks(s) : []) {
      const id = r.id as CcCriterionId;
      if (out.some((w) => w.label.includes(CC_CRITERIA_BY_ID[id].label))) continue;
      out.push({
        label: `Top risk: ${r.label} (scored ${s[id]})`,
        detail: `Biggest weighted gap to a perfect score${rationale(scoreRationales, id)}`,
      });
    }
  } else {
    for (const id of GATE_IDS) {
      if (gates[id] === "N") {
        out.push({
          label: `FAILED GATE: ${GATES_BY_ID[id].label}`,
          detail: `${GATES_BY_ID[id].nMeans}${rationale(gateRationales, id)}`,
        });
      }
    }
    const s = Object.fromEntries(
      CRITERION_IDS.map((id) => {
        const v = scores[id];
        return [
          id,
          typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 5
            ? v
            : null,
        ];
      }),
    ) as Record<CriterionId, number | null>;
    for (const id of killerFlags(s, weights)) {
      out.push({
        label: `Killer flag: ${CRITERIA_BY_ID[id].label} scored ${s[id]}`,
        detail: `Low score on a heavyweight criterion${rationale(scoreRationales, id)}`,
      });
    }
    // topRisks is null unless fully scored — partial scoring still yields
    // failed gates and killer flags above.
    for (const r of topRisks(s, weights) ?? []) {
      const label = CRITERIA_BY_ID[r.id].label;
      if (out.some((w) => w.label.includes(label))) continue;
      out.push({
        label: `Top risk: ${label} (scored ${s[r.id]})`,
        detail: `Biggest weighted gap to a perfect score${rationale(scoreRationales, r.id)}`,
      });
    }
  }
  return out.slice(0, 10);
}

export interface Reframe {
  name: string;
  pitch: string;
  whatChanged: string;
  risksAddressed: string;
}

function normalizeReframes(raw: unknown): Reframe[] {
  if (!Array.isArray(raw)) return [];
  const out: Reframe[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const str = (k: string, max: number) =>
      typeof r[k] === "string" ? (r[k] as string).trim().slice(0, max) : "";
    const name = str("name", 80);
    const pitch = str("pitch", 3000);
    if (!name || !pitch) continue;
    out.push({
      name,
      pitch,
      whatChanged: str("whatChanged", 600),
      risksAddressed: str("risksAddressed", 300),
    });
    if (out.length >= 5) break;
  }
  return out;
}

export async function POST(request: Request) {
  const guard = guardRequest(request);
  if (guard) return guard;

  const body = await readJsonBody(request);
  if (!body) {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const filter =
    body.filter === "cashcow"
      ? ("cashcow" as const)
      : body.filter === "custom"
        ? ("custom" as const)
        : ("unicorn" as const);
  const customSpec =
    filter === "custom"
      ? (normalizeCustomFilterSpec(body.customSpec) ?? undefined)
      : undefined;
  if (filter === "custom" && !customSpec) {
    return Response.json(
      { error: "Invalid or missing custom filter definition." },
      { status: 400 },
    );
  }
  const provider = providerFromBody(body.provider);
  const model = modelFromBody(body.model);
  const rawIdea = record(body.idea);
  const idea = {
    name: field(rawIdea.name, 200),
    domain: field(rawIdea.domain, 200),
    businessModel: field(rawIdea.businessModel, 200),
    buyerICP: field(rawIdea.buyerICP, 500),
    initialWedge: field(rawIdea.initialWedge, 500),
    thesisNotes: field(rawIdea.thesisNotes),
  };
  const founderBackground = field(body.founderBackground, MAX_BACKGROUND_CHARS);
  const coFounders = coFoundersFromBody(body.coFounders);
  const clarifications = normalizeClarifications(body.clarifications);
  const aiSummary = field(body.aiSummary, 3000);

  if (!model) {
    return Response.json({ error: "No model selected." }, { status: 400 });
  }
  if (!idea.thesisNotes.trim() && !idea.name.trim()) {
    return Response.json(
      { error: "The idea needs at least a name or description to reframe." },
      { status: 400 },
    );
  }

  const missing = keyMissingResponse(provider);
  if (missing) return missing;

  let logRun: (() => Promise<void>) | null = null;
  if (cloudConfigured()) {
    const caller = await resolveCaller();
    if (isPremiumModel(model) && !caller.subscribed && !caller.isAdmin) {
      return Response.json(
        {
          error:
            "That model is available to subscribers — upgrade for $19/month in Settings, or pick a non-premium model.",
          upgrade: true,
        },
        { status: 402 },
      );
    }
    const admin = adminClient();
    const telemetry = requestTelemetry(request);
    const anonKey = anonKeyFromBody(body.anonKey);
    logRun = async () => {
      await admin.from("submission_logs").insert({
        user_id: caller.user?.id ?? null,
        anon_key: caller.user ? null : anonKey,
        action:
          filter === "cashcow"
            ? "reframe_cashcow"
            : filter === "custom"
              ? "reframe_custom"
              : "reframe",
        ...telemetry,
        provider,
        model,
      });
    };
  }

  const weaknesses = buildWeaknesses(
    filter,
    record(body.gates),
    record(body.scores),
    record(body.gateRationales),
    record(body.scoreRationales),
    weightsFromBody(body.weights),
    customSpec,
  );

  try {
    const result = await callProviderJSON({
      provider,
      model,
      system: buildReframeSystemPrompt(filter, customSpec),
      prompt: buildReframePrompt(
        idea,
        weaknesses,
        founderBackground,
        coFounders,
        clarifications,
        aiSummary,
      ),
      schemaName: "idea_reframes",
      schema: REFRAME_SCHEMA as unknown as Record<string, unknown>,
      webSearch: false,
      speed: "quality",
      tier: "standard",
    });
    const raw = parseLastJSON<{ reframes?: unknown }>(result.texts);
    const reframes = normalizeReframes(raw.reframes);
    if (reframes.length === 0) {
      throw new Error("The model returned no usable reframes. Try again.");
    }
    await logRun?.();
    return Response.json({ reframes, provider, model });
  } catch (err) {
    return mapProviderError(err, model);
  }
}
