// Server-side helpers shared by the AI API routes (/api/analyze, /api/clarify):
// request guards, provider dispatch with structured JSON output, and error
// mapping. Never import this from client components.
import Anthropic from "@anthropic-ai/sdk";
import { recordModelPing } from "@/lib/db/modelPings";
import OpenAI from "openai";
import { STANDARD_WEB_SEARCH_CAP } from "@/lib/entitlements";
import type { Provider } from "@/lib/types";

export class UserFacingError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Request guards. These endpoints spend the deployment owner's API credits, so
// they get same-origin enforcement, input size caps, and a best-effort per-IP
// rate limit (per serverless instance — a determined attacker needs
// provider-side spend limits, noted in the README).
// ---------------------------------------------------------------------------

export const MAX_FIELD_CHARS = 20_000;
export const MAX_BACKGROUND_CHARS = 60_000;
const RATE_LIMIT_PER_MINUTE = 10;
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

/** Same-origin gate only — for authenticated poll endpoints where the
 *  per-IP rate limit would false-positive on legitimate multi-tab polling. */
export function guardOrigin(request: Request): Response | null {
  if (!sameOrigin(request)) {
    return Response.json(
      { error: "Cross-origin requests are not allowed." },
      { status: 403 },
    );
  }
  return null;
}

/** Origin + rate-limit gate. Returns an error Response to send, or null to proceed. */
export function guardRequest(request: Request): Response | null {
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
      { error: "Too many AI requests — wait a minute and try again." },
      { status: 429 },
    );
  }
  return null;
}

/** Parse and shape-check the JSON body. Returns null when invalid. */
export async function readJsonBody(
  request: Request,
): Promise<Record<string, unknown> | null> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

export function field(value: unknown, max = MAX_FIELD_CHARS): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

const MAX_COFOUNDERS = 4;

/** Validate and cap the coFounders array from a request body. */
export function coFoundersFromBody(
  value: unknown,
): { name: string; background: string }[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_COFOUNDERS).flatMap((c) => {
    if (!c || typeof c !== "object") return [];
    const cf = c as { name?: unknown; background?: unknown };
    const background = field(cf.background, MAX_BACKGROUND_CHARS).trim();
    if (!background) return [];
    return [{ name: field(cf.name, 200).trim(), background }];
  });
}

export function providerFromBody(value: unknown): Provider {
  return value === "openai" ? "openai" : "anthropic";
}

export function modelFromBody(value: unknown): string | null {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, 200)
    : null;
}

/** Returns an error Response when the provider's key is missing, else null. */
export function keyMissingResponse(provider: Provider): Response | null {
  const present =
    provider === "anthropic"
      ? Boolean(process.env.ANTHROPIC_API_KEY)
      : Boolean(process.env.OPENAI_API_KEY);
  if (present) return null;
  const envVar = provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
  return Response.json(
    {
      error: `${provider === "anthropic" ? "Anthropic" : "OpenAI"} is not configured on this deployment. Set the ${envVar} environment variable (in Vercel: Project → Settings → Environment Variables) and redeploy.`,
    },
    { status: 503 },
  );
}

/** The shared catch-chain for provider calls. */
export function mapProviderError(err: unknown, model: string): Response {
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
  return Response.json({ error: `AI request failed: ${message}` }, { status: 500 });
}

// ---------------------------------------------------------------------------
// Provider dispatch with structured JSON output.
// ---------------------------------------------------------------------------

// Claude 4.6+ models take adaptive thinking; on Fable 5 thinking is always on
// and {type: "adaptive"} is the only accepted explicit value.
const ADAPTIVE_THINKING_MODELS =
  /^claude-(opus-4-[678]|sonnet-5|sonnet-4-6|fable-5|mythos-5)/;
// Models supporting web search with dynamic filtering (web_search_20260209+).
const DYNAMIC_SEARCH_MODELS =
  /^claude-(fable-5|mythos-5|opus-4-[678]|sonnet-5|sonnet-4-6)/;
const FABLE_MODELS = /^claude-(fable-5|mythos-5)/;
// Models accepting output_config.effort (Haiku 4.5 and older reject it).
const ANTHROPIC_EFFORT_MODELS =
  /^claude-(fable-5|mythos-5|opus-4-[5678]|sonnet-5|sonnet-4-6)/;
// Reasoning-capable OpenAI families (gpt-5*, o-series); gpt-4.x is not.
const OPENAI_REASONING_MODELS = /^(gpt-5|o\d)/;
// xhigh reasoning effort exists on models after gpt-5.1-codex-max (e.g. gpt-5.5).
const OPENAI_XHIGH_MODELS = /^gpt-5\.[5-9]/;
// -pro reasoning models accept only "high" effort — no low/xhigh.
const OPENAI_HIGH_ONLY_MODELS = /^(gpt-5-pro|o\d-pro)/;

// Premium (subscriber/admin/local) analyses run uncapped web search; the free
// tier is hard-capped at STANDARD_WEB_SEARCH_CAP via the tool's max_uses.
// Premium pause-turn continuations get a higher ceiling so an uncapped search
// run isn't cut short mid-turn.
const MAX_PAUSE_CONTINUATIONS = 5;
const MAX_PAUSE_CONTINUATIONS_PREMIUM = 20;

export interface JSONCallOptions {
  provider: Provider;
  model: string;
  system: string;
  prompt: string;
  schemaName: string;
  schema: Record<string, unknown>;
  webSearch: boolean;
  /**
   * "quality" applies the per-model policy effort; "fast" nudges effort low
   * for snappy helper calls like clarifying questions and metadata fills.
   */
  speed: "quality" | "fast";
  /**
   * Effort tier: subscribers/admins (and local-only deployments) run
   * "premium" — GPT-5.5 at xhigh; free/anon callers run "standard" —
   * GPT-5.5 capped at medium. Anthropic policy: Fable 5 xhigh (the model
   * itself is subscriber-gated), Sonnet 5 medium for everyone.
   */
  tier: "premium" | "standard";
  /**
   * Explicit hard cap on web-search tool uses (Anthropic max_uses), overriding
   * the tier default. Use for bounded helper routes (e.g. profile lookups) that
   * shouldn't inherit the analysis flow's uncapped premium search.
   */
  maxWebSearches?: number;
  /** BYOK: the caller's own provider key. Undefined → deployment env key. */
  apiKey?: string;
  /** Explicit effort override — wins over the per-model/tier policy. Used
   *  by the autonomous Cash Cow scorer to force Opus 4.8 / Sol at max. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Ledger label for model_pings — defaults to the schemaName. */
  purpose?: string;
  /** Output-token ceiling override (Anthropic max_tokens). Max-effort
   *  scoring over a long idea can exceed the 16k default and trip
   *  stop_reason=max_tokens. */
  maxTokens?: number;
}

export interface JSONCallResult {
  /** Text blocks in response order — the structured JSON is normally the last. */
  texts: string[];
  webSearches: number;
}

export async function callProviderJSON(
  opts: JSONCallOptions,
): Promise<JSONCallResult> {
  return opts.provider === "anthropic"
    ? anthropicJSON(opts)
    : openaiJSON(opts);
}

/** Walk backwards over candidate text blocks and return the last parseable JSON. */
export function parseLastJSON<T>(texts: string[]): T {
  for (let i = texts.length - 1; i >= 0; i--) {
    const text = texts[i];
    if (!text) continue;
    try {
      return JSON.parse(text) as T;
    } catch {
      // Not the JSON block — keep walking backwards.
    }
  }
  throw new UserFacingError(
    "The model returned no parseable output. Try again or switch models.",
  );
}

export function isGrammarTooLarge(err: unknown): boolean {
  return (
    err instanceof Anthropic.APIError &&
    err.status === 400 &&
    /grammar is too large|reduce the number of strict tools/i.test(err.message)
  );
}

async function anthropicJSON(opts: JSONCallOptions): Promise<JSONCallResult> {
  // Anthropic compiles the output schema (and tool grammars) into one
  // constrained-decoding grammar with a hard size limit. If a request trips
  // it, degrade gracefully: drop web search first, then fall back from the
  // enforced schema to a JSON instruction + parse.
  try {
    return await anthropicJSONAttempt(opts, { format: true });
  } catch (err) {
    if (!isGrammarTooLarge(err)) throw err;
  }
  if (opts.webSearch) {
    try {
      return await anthropicJSONAttempt(
        { ...opts, webSearch: false },
        { format: true },
      );
    } catch (err) {
      if (!isGrammarTooLarge(err)) throw err;
    }
  }
  return anthropicJSONAttempt({ ...opts, webSearch: false }, { format: false });
}

async function anthropicJSONAttempt(
  opts: JSONCallOptions,
  attempt: { format: boolean },
): Promise<JSONCallResult> {
  const client = new Anthropic({
    apiKey: opts.apiKey ?? process.env.ANTHROPIC_API_KEY,
    // Max-effort + web-search calls can exceed the SDK's 10-min default —
    // it was aborting them at 600s inside the 30-min function window.
    timeout: 1_500_000,
  });
  const isFable = FABLE_MODELS.test(opts.model);

  const effort =
    opts.effort && ANTHROPIC_EFFORT_MODELS.test(opts.model)
      ? opts.effort
      : opts.speed === "fast"
        ? ANTHROPIC_EFFORT_MODELS.test(opts.model)
          ? ("low" as const)
          : undefined
        : isFable
          ? ("xhigh" as const)
          : /^claude-sonnet-5/.test(opts.model)
            ? ("medium" as const)
            : undefined;

  // An explicit maxWebSearches (bounded helper routes) always wins. Otherwise:
  // premium tier gets uncapped search (omit max_uses), the free tier is
  // hard-capped — aligned with the prompt's budget (buildSystemPrompt), both
  // keyed off STANDARD_WEB_SEARCH_CAP.
  const maxUses =
    opts.maxWebSearches !== undefined
      ? opts.maxWebSearches
      : opts.tier === "premium"
        ? undefined
        : STANDARD_WEB_SEARCH_CAP;
  const maxUsesField = maxUses === undefined ? {} : { max_uses: maxUses };
  const tools: Anthropic.ToolUnion[] | undefined = opts.webSearch
    ? [
        DYNAMIC_SEARCH_MODELS.test(opts.model)
          ? {
              type: "web_search_20260209",
              name: "web_search",
              ...maxUsesField,
            }
          : {
              type: "web_search_20250305",
              name: "web_search",
              ...maxUsesField,
            },
      ]
    : undefined;

  const system = attempt.format
    ? opts.system
    : `${opts.system}\n\nRespond with ONLY a single valid JSON object exactly matching this JSON Schema — no prose, no markdown fences:\n${JSON.stringify(opts.schema)}`;

  const baseParams = {
    model: opts.model,
    max_tokens: opts.maxTokens ?? (opts.speed === "fast" ? 8000 : 16000),
    ...(ADAPTIVE_THINKING_MODELS.test(opts.model)
      ? { thinking: { type: "adaptive" as const } }
      : {}),
    system,
    ...(effort || attempt.format
      ? {
          output_config: {
            ...(effort ? { effort } : {}),
            ...(attempt.format
              ? { format: { type: "json_schema" as const, schema: opts.schema } }
              : {}),
          },
        }
      : {}),
    ...(tools ? { tools } : {}),
  };

  // Fable 5's safety classifiers can decline benign-adjacent requests; opt into
  // the server-side fallback so a decline is transparently re-served by Opus.
  async function createMessage(
    messages: Anthropic.MessageParam[],
  ): Promise<Anthropic.Message> {
    // Stream under the hood: the SDK REQUIRES streaming for requests whose
    // max_tokens imply >10 min of generation (max-effort scoring at 32k
    // tokens does). finalMessage() returns the same complete Message.
    if (isFable) {
      return (await client.beta.messages
        .stream({
          ...(baseParams as unknown as Record<string, unknown>),
          messages,
          betas: ["server-side-fallback-2026-06-01"],
          fallbacks: [{ model: "claude-opus-4-8" }],
        } as unknown as Parameters<typeof client.beta.messages.stream>[0])
        .finalMessage()) as unknown as Anthropic.Message;
    }
    return client.messages
      .stream({ ...baseParams, messages })
      .finalMessage();
  }

  let messages: Anthropic.MessageParam[] = [
    { role: "user", content: opts.prompt },
  ];
  let response = await createMessage(messages);

  // Long web-search turns can pause server-side; resend to continue. Uncapped
  // premium searches can pause more often, so give them a higher ceiling.
  const pauseLimit =
    opts.tier === "premium"
      ? MAX_PAUSE_CONTINUATIONS_PREMIUM
      : MAX_PAUSE_CONTINUATIONS;
  let continuations = 0;
  while (
    response.stop_reason === "pause_turn" &&
    continuations++ < pauseLimit
  ) {
    messages = [...messages, { role: "assistant", content: response.content }];
    response = await createMessage(messages);
  }

  if (response.stop_reason === "refusal") {
    throw new UserFacingError(
      "The model declined this input. Rephrase the idea description and try again.",
    );
  }
  if (response.stop_reason === "max_tokens") {
    throw new UserFacingError(
      "The response ran over the output limit. Try a shorter idea description or founder background.",
    );
  }

  const usage = response.usage as unknown as {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    server_tool_use?: { web_search_requests?: number };
  };
  await recordModelPing({
    provider: "anthropic",
    model: opts.model,
    purpose: opts.purpose ?? `api:${opts.schemaName}`,
    usage: {
      inTokens: usage?.input_tokens ?? 0,
      cachedInTokens: usage?.cache_read_input_tokens ?? 0,
      cacheWriteTokens: usage?.cache_creation_input_tokens ?? 0,
      outTokens: usage?.output_tokens ?? 0,
      webSearches: usage?.server_tool_use?.web_search_requests ?? 0,
    },
  });
  return {
    texts: response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text),
    webSearches: usage?.server_tool_use?.web_search_requests ?? 0,
  };
}

async function openaiJSON(opts: JSONCallOptions): Promise<JSONCallResult> {
  const client = new OpenAI({
    apiKey: opts.apiKey ?? process.env.OPENAI_API_KEY,
    timeout: 1_500_000,
  });

  const overrideEffort =
    opts.effort && OPENAI_REASONING_MODELS.test(opts.model)
      ? opts.effort === "max"
        ? OPENAI_XHIGH_MODELS.test(opts.model)
          ? ("xhigh" as const)
          : ("high" as const)
        : (opts.effort as "low" | "medium" | "high" | "xhigh")
      : null;
  const effort = overrideEffort
    ? overrideEffort
    : OPENAI_REASONING_MODELS.test(opts.model)
      ? OPENAI_HIGH_ONLY_MODELS.test(opts.model)
        ? ("high" as const)
        : opts.speed === "fast"
          ? ("low" as const)
          : OPENAI_XHIGH_MODELS.test(opts.model)
            ? opts.tier === "premium"
              ? ("xhigh" as const)
              : ("medium" as const)
            : ("high" as const)
      : null;

  const response = await client.responses.create({
    model: opts.model,
    instructions: opts.system,
    input: opts.prompt,
    ...(opts.webSearch ? { tools: [{ type: "web_search" as const }] } : {}),
    ...(effort ? { reasoning: { effort } } : {}),
    text: {
      format: {
        type: "json_schema",
        name: opts.schemaName,
        strict: true,
        schema: opts.schema,
      },
    },
  });

  const refusal = response.output
    ?.filter((item) => item.type === "message")
    .flatMap((m) => m.content)
    .find((c) => c.type === "refusal");
  if (refusal) {
    throw new UserFacingError(
      "The model declined this input. Rephrase the idea description and try again.",
    );
  }
  if (response.status === "incomplete") {
    throw new UserFacingError(
      `The model stopped early (${response.incomplete_details?.reason ?? "unknown reason"}). Try again.`,
    );
  }

  await recordModelPing({
    provider: "openai",
    model: opts.model,
    purpose: opts.purpose ?? `api:${opts.schemaName}`,
    usage: {
      inTokens: response.usage?.input_tokens ?? 0,
      cachedInTokens: response.usage?.input_tokens_details?.cached_tokens ?? 0,
      outTokens: response.usage?.output_tokens ?? 0,
      webSearches:
        response.output?.filter((item) => item.type === "web_search_call")
          .length ?? 0,
    },
  });
  return {
    texts: response.output_text ? [response.output_text] : [],
    webSearches:
      response.output?.filter((item) => item.type === "web_search_call")
        .length ?? 0,
  };
}
