// Designs a founder's custom scoring instrument from their stated goals
// (target net profit, hours/day, years, capital, team size, other qualities).
// The result is a validated CustomFilterSpec the client stores in settings.
// Quota-free like the other helper routes (no web search), premium-gated,
// logged. Custom filters are private: never published, admin-visible.
import {
  buildFilterDesignPrompt,
  FILTER_DESIGN_SYSTEM_PROMPT,
  type CustomFilterInputsPrompt,
} from "@/lib/ai/prompt";
import { FILTER_DESIGN_SCHEMA } from "@/lib/ai/schema";
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
import { isPremiumModel } from "@/lib/entitlements";
import {
  adminClient,
  anonKeyFromBody,
  cloudConfigured,
  requestTelemetry,
  resolveCaller,
} from "@/lib/supabase/server";
import { normalizeCustomFilterSpec } from "@/lib/types";
import type { CustomFilterSpec } from "@/lib/types";

export const maxDuration = 300;

function num(v: unknown, lo: number, hi: number, fb: number): number {
  return typeof v === "number" && Number.isFinite(v)
    ? Math.min(hi, Math.max(lo, v))
    : fb;
}

export async function POST(request: Request) {
  const guard = guardRequest(request);
  if (guard) return guard;

  const body = await readJsonBody(request);
  if (!body) {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const provider = providerFromBody(body.provider);
  const model = modelFromBody(body.model);
  if (!model) {
    return Response.json({ error: "No model selected." }, { status: 400 });
  }

  const rawInputs =
    body.inputs && typeof body.inputs === "object" && !Array.isArray(body.inputs)
      ? (body.inputs as Record<string, unknown>)
      : {};
  const inputs: CustomFilterInputsPrompt = {
    netProfitTarget: num(rawInputs.netProfitTarget, 1000, 1e9, 1_000_000),
    hoursPerDay: num(rawInputs.hoursPerDay, 1, 24, 8),
    yearsToBuild: num(rawInputs.yearsToBuild, 0.5, 50, 5),
    capitalAvailable: field(rawInputs.capitalAvailable, 200),
    maxTeamSize: field(rawInputs.maxTeamSize, 200),
    wantsToSell:
      rawInputs.wantsToSell === "yes" || rawInputs.wantsToSell === "no"
        ? (rawInputs.wantsToSell as string)
        : "maybe",
    otherQualities: field(rawInputs.otherQualities, 2000),
  };
  const founderBackground = field(body.founderBackground, MAX_BACKGROUND_CHARS);
  const coFounders = coFoundersFromBody(body.coFounders);
  // The client supplies the identity for a regenerate (same id, version+1).
  const existingId = field(body.existingId, 64);
  const existingVersion = num(body.existingVersion, 1, 10_000, 0);

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
        action: "filter_design",
        ...telemetry,
        provider,
        model,
      });
    };
  }

  try {
    const result = await callProviderJSON({
      provider,
      model,
      system: FILTER_DESIGN_SYSTEM_PROMPT,
      prompt: buildFilterDesignPrompt(inputs, founderBackground, coFounders),
      schemaName: "filter_design",
      schema: FILTER_DESIGN_SCHEMA as unknown as Record<string, unknown>,
      webSearch: false,
      speed: "quality",
      tier: "standard",
    });
    const raw = parseLastJSON<Record<string, unknown>>(result.texts);

    // Run the model's design through the same normalizer the client and
    // server trust everywhere else — ids assigned, weights rescaled to 100.
    const spec: CustomFilterSpec | null = normalizeCustomFilterSpec({
      ...raw,
      id: existingId || crypto.randomUUID(),
      version: existingVersion > 0 ? existingVersion + 1 : 1,
      inputs,
      createdAt: new Date().toISOString(),
    });
    if (!spec) {
      throw new Error(
        "The model returned an unusable filter design. Try again.",
      );
    }
    await logRun?.();
    return Response.json({ spec, provider, model });
  } catch (err) {
    return mapProviderError(err, model);
  }
}
