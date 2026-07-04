import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GATES } from "@/lib/criteria";
import { buildUserPrompt, SYSTEM_PROMPT } from "@/lib/ai/prompt";
import type { AnalyzeRequestIdea } from "@/lib/ai/prompt";
import { ANALYSIS_SCHEMA } from "@/lib/ai/schema";
import { CRITERION_IDS, GATE_IDS } from "@/lib/types";
import type { AnalyzeResponse, CriterionId, GateId, Provider } from "@/lib/types";

// AI analysis with a thinking model can take a while — allow long invocations.
export const maxDuration = 300;

const FOUNDER_PERSONAL_GATES = GATES.filter((g) => g.founderPersonal).map(
  (g) => g.id,
);

interface RawAnalysis {
  summary: string;
  gates: Record<string, { value: string; rationale: string }>;
  scores: Record<string, { score: number; rationale: string }>;
  confidence: string;
  confidenceRationale: string;
  validationTest30d: string;
  needsFounderConfirmation: string[];
}

function normalize(
  raw: RawAnalysis,
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
    gates,
    scores,
    confidence,
    confidenceRationale: raw.confidenceRationale ?? "",
    validationTest30d: raw.validationTest30d ?? "",
    needsFounderConfirmation: [...needsConfirmation],
    provider,
    model,
  };
}

const ADAPTIVE_THINKING_MODELS =
  /^claude-(opus-4-[678]|sonnet-5|sonnet-4-6|fable-5|mythos-5)/;

async function analyzeWithAnthropic(
  model: string,
  userPrompt: string,
): Promise<RawAnalysis> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model,
    max_tokens: 16000,
    ...(ADAPTIVE_THINKING_MODELS.test(model)
      ? { thinking: { type: "adaptive" as const } }
      : {}),
    system: SYSTEM_PROMPT,
    output_config: {
      format: {
        type: "json_schema",
        schema: ANALYSIS_SCHEMA as unknown as Record<string, unknown>,
      },
    },
    messages: [{ role: "user", content: userPrompt }],
  });

  if (response.stop_reason === "refusal") {
    throw new UserFacingError(
      "The model declined to analyze this input. Rephrase the idea description and try again.",
    );
  }
  if (response.stop_reason === "max_tokens") {
    throw new UserFacingError(
      "The analysis ran over the output limit. Try a shorter idea description or founder background.",
    );
  }
  const text = response.content.find((b) => b.type === "text")?.text;
  if (!text) throw new UserFacingError("The model returned no analysis text.");
  return JSON.parse(text) as RawAnalysis;
}

async function analyzeWithOpenAI(
  model: string,
  userPrompt: string,
): Promise<RawAnalysis> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "idea_analysis",
        strict: true,
        schema: ANALYSIS_SCHEMA as unknown as Record<string, unknown>,
      },
    },
  });

  const message = response.choices[0]?.message;
  if (message?.refusal) {
    throw new UserFacingError(
      "The model declined to analyze this input. Rephrase the idea description and try again.",
    );
  }
  if (!message?.content) {
    throw new UserFacingError("The model returned no analysis text.");
  }
  return JSON.parse(message.content) as RawAnalysis;
}

class UserFacingError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
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

// This endpoint spends the deployment owner's API credits, so it gets basic
// abuse protection: same-origin enforcement, input size caps, and a
// best-effort per-IP rate limit (per serverless instance — a determined
// attacker needs provider-side spend limits, noted in the README).
const RATE_LIMIT_PER_MINUTE = 10;
const MAX_FIELD_CHARS = 20_000;
const MAX_BACKGROUND_CHARS = 60_000;
const rateBuckets = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const hits = (rateBuckets.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (hits.length >= RATE_LIMIT_PER_MINUTE) {
    rateBuckets.set(ip, hits);
    return true;
  }
  hits.push(now);
  rateBuckets.set(ip, hits);
  if (rateBuckets.size > 10_000) rateBuckets.clear();
  return false;
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true; // same-origin fetches may omit the header
  const host = request.headers.get("host");
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function field(value: unknown): string {
  return typeof value === "string" ? value.slice(0, MAX_FIELD_CHARS) : "";
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return Response.json(
      { error: "Cross-origin requests are not allowed." },
      { status: 403 },
    );
  }
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  if (rateLimited(ip)) {
    return Response.json(
      { error: "Too many analyses — wait a minute and try again." },
      { status: 429 },
    );
  }

  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const body = parsed as {
    idea?: unknown;
    founderBackground?: unknown;
    provider?: unknown;
    model?: unknown;
  };

  const provider: Provider = body.provider === "openai" ? "openai" : "anthropic";
  const model =
    typeof body.model === "string" && body.model.trim()
      ? body.model.trim().slice(0, 200)
      : null;

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
  const founderBackground =
    typeof body.founderBackground === "string"
      ? body.founderBackground.slice(0, MAX_BACKGROUND_CHARS)
      : "";

  const keyPresent =
    provider === "anthropic"
      ? Boolean(process.env.ANTHROPIC_API_KEY)
      : Boolean(process.env.OPENAI_API_KEY);
  if (!keyPresent) {
    const envVar = provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
    return Response.json(
      {
        error: `${provider === "anthropic" ? "Anthropic" : "OpenAI"} is not configured on this deployment. Set the ${envVar} environment variable (in Vercel: Project → Settings → Environment Variables) and redeploy.`,
      },
      { status: 503 },
    );
  }

  const userPrompt = buildUserPrompt(idea, founderBackground);

  try {
    const raw =
      provider === "anthropic"
        ? await analyzeWithAnthropic(model, userPrompt)
        : await analyzeWithOpenAI(model, userPrompt);
    return Response.json(normalize(raw, provider, model));
  } catch (err) {
    if (err instanceof UserFacingError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    if (err instanceof SyntaxError) {
      return Response.json(
        { error: "The model returned malformed JSON. Try again or switch models." },
        { status: 502 },
      );
    }
    if (err instanceof Anthropic.APIError) {
      const status = err.status ?? 502;
      const msg =
        status === 401
          ? "The Anthropic API key on this deployment is invalid."
          : status === 404
            ? `Unknown Anthropic model "${model}". Check the model id in Settings.`
            : status === 429
              ? "Anthropic rate limit reached — wait a moment and try again."
              : `Anthropic API error: ${err.message}`;
      return Response.json({ error: msg }, { status: status >= 500 ? 502 : status });
    }
    if (err instanceof OpenAI.APIError) {
      const status = err.status ?? 502;
      const msg =
        status === 401
          ? "The OpenAI API key on this deployment is invalid."
          : status === 404
            ? `Unknown OpenAI model "${model}". Check the model id in Settings.`
            : status === 429
              ? "OpenAI rate limit reached — wait a moment and try again."
              : `OpenAI API error: ${err.message}`;
      return Response.json({ error: msg }, { status: status >= 500 ? 502 : status });
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return Response.json({ error: `Analysis failed: ${message}` }, { status: 500 });
  }
}
