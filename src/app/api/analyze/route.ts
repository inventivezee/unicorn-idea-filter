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
  metadata?: Record<string, unknown>;
  gates: Record<string, { value: string; rationale: string }>;
  scores: Record<string, { score: number; rationale: string }>;
  confidence: string;
  confidenceRationale: string;
  validationTest30d: string;
  needsFounderConfirmation: string[];
}

interface ProviderResult {
  raw: RawAnalysis;
  webSearches: number;
}

function normalize(
  { raw, webSearches }: ProviderResult,
  provider: Provider,
  model: string,
): AnalyzeResponse {
  const meta = raw.metadata ?? {};
  const metaStr = (key: string) => {
    const v = meta[key];
    return typeof v === "string" ? v.trim() : "";
  };
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
    metadata: {
      name: metaStr("name").slice(0, 80),
      domain: metaStr("domain"),
      businessModel: metaStr("businessModel"),
      buyerICP: metaStr("buyerICP"),
      initialWedge: metaStr("initialWedge"),
    },
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

// Claude 4.6+ models take adaptive thinking; on Fable 5 thinking is always on
// and {type: "adaptive"} is the only accepted explicit value.
const ADAPTIVE_THINKING_MODELS =
  /^claude-(opus-4-[678]|sonnet-5|sonnet-4-6|fable-5|mythos-5)/;
// Models supporting web search with dynamic filtering (web_search_20260209+).
const DYNAMIC_SEARCH_MODELS =
  /^claude-(fable-5|mythos-5|opus-4-[678]|sonnet-5|sonnet-4-6)/;
const FABLE_MODELS = /^claude-(fable-5|mythos-5)/;
const MAX_WEB_SEARCHES = 5;
const MAX_PAUSE_CONTINUATIONS = 5;

function parseAnalysisText(text: string | undefined): RawAnalysis {
  if (!text) throw new UserFacingError("The model returned no analysis text.");
  return JSON.parse(text) as RawAnalysis;
}

async function analyzeWithAnthropic(
  model: string,
  userPrompt: string,
  webSearch: boolean,
): Promise<ProviderResult> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const isFable = FABLE_MODELS.test(model);

  const tools: Anthropic.ToolUnion[] | undefined = webSearch
    ? [
        DYNAMIC_SEARCH_MODELS.test(model)
          ? {
              type: "web_search_20260209",
              name: "web_search",
              max_uses: MAX_WEB_SEARCHES,
            }
          : {
              type: "web_search_20250305",
              name: "web_search",
              max_uses: MAX_WEB_SEARCHES,
            },
      ]
    : undefined;

  const baseParams = {
    model,
    max_tokens: 16000,
    ...(ADAPTIVE_THINKING_MODELS.test(model)
      ? { thinking: { type: "adaptive" as const } }
      : {}),
    system: SYSTEM_PROMPT,
    output_config: {
      // xhigh effort on Fable 5 per app policy; other models keep the default.
      ...(isFable ? { effort: "xhigh" as const } : {}),
      format: {
        type: "json_schema" as const,
        schema: ANALYSIS_SCHEMA as unknown as Record<string, unknown>,
      },
    },
    ...(tools ? { tools } : {}),
  };

  // Fable 5's safety classifiers can decline benign-adjacent requests; opt into
  // the server-side fallback so a decline is transparently re-served by Opus.
  async function createMessage(
    messages: Anthropic.MessageParam[],
  ): Promise<Anthropic.Message> {
    if (isFable) {
      return (await client.beta.messages.create({
        ...(baseParams as unknown as Record<string, unknown>),
        messages,
        betas: ["server-side-fallback-2026-06-01"],
        fallbacks: [{ model: "claude-opus-4-8" }],
      } as unknown as Parameters<typeof client.beta.messages.create>[0])) as unknown as Anthropic.Message;
    }
    return client.messages.create({ ...baseParams, messages });
  }

  let messages: Anthropic.MessageParam[] = [
    { role: "user", content: userPrompt },
  ];
  let response = await createMessage(messages);

  // Long web-search turns can pause server-side; resend to continue.
  let continuations = 0;
  while (
    response.stop_reason === "pause_turn" &&
    continuations++ < MAX_PAUSE_CONTINUATIONS
  ) {
    messages = [...messages, { role: "assistant", content: response.content }];
    response = await createMessage(messages);
  }

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

  // With server tools in play the response may hold several text blocks
  // (search narration + final answer) — the structured JSON is the last one
  // that parses.
  const textBlocks = response.content.filter((b) => b.type === "text");
  let raw: RawAnalysis | null = null;
  for (let i = textBlocks.length - 1; i >= 0; i--) {
    try {
      raw = parseAnalysisText(textBlocks[i].text);
      break;
    } catch {
      // Not the JSON block — keep walking backwards.
    }
  }
  if (!raw) {
    throw new UserFacingError(
      "The model returned no parseable analysis. Try again or switch models.",
    );
  }

  const usage = response.usage as unknown as {
    server_tool_use?: { web_search_requests?: number };
  };
  return {
    raw,
    webSearches: usage?.server_tool_use?.web_search_requests ?? 0,
  };
}

// Reasoning-capable OpenAI families (gpt-5*, o-series); gpt-4.x is not.
const OPENAI_REASONING_MODELS = /^(gpt-5|o\d)/;
// xhigh reasoning effort exists on models after gpt-5.1-codex-max (e.g. gpt-5.5).
const OPENAI_XHIGH_MODELS = /^gpt-5\.[5-9]/;

async function analyzeWithOpenAI(
  model: string,
  userPrompt: string,
  webSearch: boolean,
): Promise<ProviderResult> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await client.responses.create({
    model,
    instructions: SYSTEM_PROMPT,
    input: userPrompt,
    ...(webSearch ? { tools: [{ type: "web_search" as const }] } : {}),
    ...(OPENAI_REASONING_MODELS.test(model)
      ? {
          reasoning: {
            effort: OPENAI_XHIGH_MODELS.test(model)
              ? ("xhigh" as const)
              : ("high" as const),
          },
        }
      : {}),
    text: {
      format: {
        type: "json_schema",
        name: "idea_analysis",
        strict: true,
        schema: ANALYSIS_SCHEMA as unknown as Record<string, unknown>,
      },
    },
  });

  const refusal = response.output
    ?.filter((item) => item.type === "message")
    .flatMap((m) => m.content)
    .find((c) => c.type === "refusal");
  if (refusal) {
    throw new UserFacingError(
      "The model declined to analyze this input. Rephrase the idea description and try again.",
    );
  }
  if (response.status === "incomplete") {
    throw new UserFacingError(
      `The analysis stopped early (${response.incomplete_details?.reason ?? "unknown reason"}). Try again.`,
    );
  }

  const webSearches =
    response.output?.filter((item) => item.type === "web_search_call").length ??
    0;
  return { raw: parseAnalysisText(response.output_text), webSearches };
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
    webSearch?: unknown;
  };
  const webSearch = body.webSearch !== false;

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
    const result =
      provider === "anthropic"
        ? await analyzeWithAnthropic(model, userPrompt, webSearch)
        : await analyzeWithOpenAI(model, userPrompt, webSearch);
    return Response.json(normalize(result, provider, model));
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
