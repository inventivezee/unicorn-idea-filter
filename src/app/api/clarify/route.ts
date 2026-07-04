import { buildClarifyPrompt, CLARIFY_SYSTEM_PROMPT } from "@/lib/ai/prompt";
import { CLARIFY_SCHEMA } from "@/lib/ai/schema";
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
import type { ClarifyQuestion, ClarifyResponse } from "@/lib/types";

// Question generation runs at low effort, but reasoning models still think.
export const maxDuration = 120;

export async function POST(request: Request) {
  const guard = guardRequest(request);
  if (guard) return guard;

  const body = await readJsonBody(request);
  if (!body) {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const provider = providerFromBody(body.provider);
  const model = modelFromBody(body.model);
  const description = field(body.description).trim();
  const founderBackground = field(body.founderBackground, MAX_BACKGROUND_CHARS);
  const coFounders = coFoundersFromBody(body.coFounders);

  if (!model) {
    return Response.json({ error: "No model selected." }, { status: 400 });
  }
  if (!description) {
    return Response.json(
      { error: "Describe the idea first." },
      { status: 400 },
    );
  }

  const missing = keyMissingResponse(provider);
  if (missing) return missing;

  let logClarify: (() => Promise<void>) | null = null;
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
    logClarify = async () => {
      await admin.from("submission_logs").insert({
        user_id: caller.user?.id ?? null,
        anon_key: caller.user ? null : anonKey,
        action: "clarify",
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
      system: CLARIFY_SYSTEM_PROMPT,
      prompt: buildClarifyPrompt(description, founderBackground, coFounders),
      schemaName: "clarifying_questions",
      schema: CLARIFY_SCHEMA as unknown as Record<string, unknown>,
      webSearch: false,
      speed: "fast",
      // Fast calls run at low effort regardless of tier.
      tier: "standard",
    });
    const raw = parseLastJSON<{ questions?: unknown }>(result.texts);
    // Normalize to {question, options}; tolerate a model that emits bare
    // strings (degradation ladder drops the enforced format under load).
    const questions = (Array.isArray(raw.questions) ? raw.questions : [])
      .map((q): ClarifyQuestion | null => {
        if (typeof q === "string" && q.trim()) {
          return { question: q.trim(), options: [] };
        }
        if (q && typeof q === "object") {
          const { question, options } = q as {
            question?: unknown;
            options?: unknown;
          };
          if (typeof question === "string" && question.trim()) {
            return {
              question: question.trim(),
              // Dedupe AFTER truncation so slice-collisions are caught too —
              // duplicate options would make twin chips toggle together.
              options: Array.from(
                new Set(
                  (Array.isArray(options) ? options : [])
                    .filter(
                      (o): o is string => typeof o === "string" && !!o.trim(),
                    )
                    .map((o) => o.trim().slice(0, 120)),
                ),
              ).slice(0, 4),
            };
          }
        }
        return null;
      })
      .filter((q): q is ClarifyQuestion => q !== null)
      .slice(0, 5);
    const response: ClarifyResponse = { questions };
    await logClarify?.();
    return Response.json(response);
  } catch (err) {
    return mapProviderError(err, model);
  }
}
