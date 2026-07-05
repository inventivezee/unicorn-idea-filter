// "Help me generate" — web-research-grounded idea generation, framed for the
// active instrument (unicorn = venture-scale/VC-style, cashcow = profitable/
// PE-style). Costs real provider spend with web search, so a generation run
// consumes one analysis credit (refunded on provider failure), same as a full
// analysis.
import {
  buildGeneratePrompt,
  buildGenerateSystemPrompt,
} from "@/lib/ai/prompt";
import { IDEAS_GEN_SCHEMA } from "@/lib/ai/schema";
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

// Research + generation with a thinking model takes a while.
export const maxDuration = 300;

export interface GeneratedIdea {
  name: string;
  pitch: string;
  domain: string;
  businessModel: string;
  buyerICP: string;
  initialWedge: string;
  whyNow: string;
  whyYou: string;
}

function normalizeIdeas(raw: unknown): GeneratedIdea[] {
  if (!Array.isArray(raw)) return [];
  const out: GeneratedIdea[] = [];
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
      domain: str("domain", 200),
      businessModel: str("businessModel", 200),
      buyerICP: str("buyerICP", 500),
      initialWedge: str("initialWedge", 500),
      whyNow: str("whyNow", 1000),
      whyYou: str("whyYou", 1000),
    });
    if (out.length >= 6) break;
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

  const filter = body.filter === "cashcow" ? ("cashcow" as const) : ("unicorn" as const);
  const provider = providerFromBody(body.provider);
  const model = modelFromBody(body.model);
  const industry = field(body.industry, 2000).trim();
  const founderBackground = field(body.founderBackground, MAX_BACKGROUND_CHARS);
  const coFounders = coFoundersFromBody(body.coFounders);
  const existingNames = (Array.isArray(body.existingNames) ? body.existingNames : [])
    .filter((n): n is string => typeof n === "string" && !!n.trim())
    .map((n) => n.trim().slice(0, 80))
    .slice(0, 50);

  if (!model) {
    return Response.json({ error: "No model selected." }, { status: 400 });
  }
  if (!industry && !founderBackground.trim()) {
    return Response.json(
      {
        error:
          "Describe an industry, or add your founder background in Settings so I can work from your edge.",
      },
      { status: 400 },
    );
  }

  const missing = keyMissingResponse(provider);
  if (missing) return missing;

  // Cloud enforcement: premium models, quotas, telemetry — mirrors /api/analyze.
  const anonKey = anonKeyFromBody(body.anonKey);
  let logRun: ((webSearches: number) => Promise<void>) | null = null;
  let refundQuota: (() => Promise<void>) | null = null;
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

    if (!subscribed) {
      const admin = adminClient();
      if (caller.user) {
        const { data: allowed } = await admin.rpc("consume_free_analysis", {
          p_user: caller.user.id,
          p_limit: FREE_ANALYSES_PER_MONTH,
        });
        if (!allowed) {
          return Response.json(
            {
              error: `You've used all ${FREE_ANALYSES_PER_MONTH} free AI runs this month — upgrade for unlimited generation and analyses.`,
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
              error: `Anonymous visitors get ${ANON_ANALYSES_PER_DAY} AI runs per day — sign in for ${FREE_ANALYSES_PER_MONTH} free per month, or subscribe for unlimited.`,
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

    const admin = adminClient();
    const telemetry = requestTelemetry(request);
    logRun = async (webSearches: number) => {
      await admin.from("submission_logs").insert({
        user_id: caller.user?.id ?? null,
        anon_key: caller.user ? null : anonKey,
        action: filter === "cashcow" ? "generate_cashcow" : "generate",
        ...telemetry,
        founder_background_snapshot: founderBackground || null,
        provider,
        model,
        web_searches: webSearches,
      });
    };
  }

  try {
    const searchBudget = tier === "premium" ? null : STANDARD_WEB_SEARCH_CAP;
    const result = await callProviderJSON({
      provider,
      model,
      system: buildGenerateSystemPrompt(filter, searchBudget),
      prompt: buildGeneratePrompt(
        industry,
        founderBackground,
        coFounders,
        existingNames,
      ),
      schemaName: "generated_ideas",
      schema: IDEAS_GEN_SCHEMA as unknown as Record<string, unknown>,
      webSearch: body.webSearch !== false,
      speed: "quality",
      tier,
    });
    const raw = parseLastJSON<{ ideas?: unknown }>(result.texts);
    // The provider did its (paid) work once we have parseable output — from
    // here the credit is spent. Refunding on "no usable ideas" would let a
    // prompt-injected empty result restore the quota after a full run.
    refundQuota = null;
    const ideas = normalizeIdeas(raw.ideas);
    if (ideas.length === 0) {
      throw new Error("The model returned no usable ideas. Try again.");
    }
    await logRun?.(result.webSearches);
    return Response.json({
      ideas,
      provider,
      model,
      webSearches: result.webSearches,
    });
  } catch (err) {
    await refundQuota?.().catch(() => {});
    return mapProviderError(err, model);
  }
}
