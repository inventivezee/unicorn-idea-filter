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
import type { ClarifyResponse } from "@/lib/types";

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
    });
    const raw = parseLastJSON<{ questions?: unknown }>(result.texts);
    const questions = (Array.isArray(raw.questions) ? raw.questions : [])
      .filter((q): q is string => typeof q === "string" && q.trim().length > 0)
      .map((q) => q.trim())
      .slice(0, 5);
    const response: ClarifyResponse = { questions };
    return Response.json(response);
  } catch (err) {
    return mapProviderError(err, model);
  }
}
