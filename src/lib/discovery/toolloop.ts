// Discovery tool loop — ONE provider round-trip per call, with fully
// JSON-serializable state so a turn can happen in any invocation (poll or
// cron) and a crash loses at most the turn in flight. Spend accounting
// happens in the ENGINE (turn counters bumped at claim time before calling
// into this module) — nothing here retries or loops.
//
// Research turns attach the Browserbase tools and NO output schema; each
// phase ends with a separate no-tools synthesis call that enforces the
// phase's JSON schema (sidesteps tools+format coexistence entirely, and on
// the OpenAI path lets synthesis run as a background pro-mode job — the
// Pro tier is never called synchronously, matching the design-chain rule).
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import {
  UserFacingError,
  isGrammarTooLarge,
  parseLastJSON,
} from "@/lib/ai/server";
import {
  openrouterTurn,
  type ORMessage,
  type ORTool,
} from "@/lib/ai/openrouter";
import {
  BROWSER_TOOL_DEFS,
  execBrowserTool,
  type BrowserHandle,
} from "./browserbase";
import { TASK_STATE_CHAR_BUDGET } from "./config";

const FABLE_MODELS = /^claude-(fable-5|mythos-5)/;

/** OpenAI's Responses effort enum tops out at "xhigh" — "max" is an
 *  Anthropic-only level; clamp at the boundary (matches server.ts's ceiling). */
function clampOpenAIEffort(
  effort: "low" | "medium" | "high" | "xhigh" | "max",
): "low" | "medium" | "high" | "xhigh" {
  return effort === "max" ? "xhigh" : effort;
}

// ---------------------------------------------------------------------------
// Serializable loop state (lives in discovery_tasks.phase_state).
// ---------------------------------------------------------------------------
export type LoopState =
  | { kind: "anthropic"; messages: Anthropic.MessageParam[]; lastText?: string }
  | {
      kind: "openai";
      responseId: string | null;
      pending: PendingCall[];
      lastText?: string;
      wrapUpPending?: boolean;
    }
  | { kind: "openrouter"; messages: ORMessage[]; lastText?: string };

interface PendingCall {
  callId: string;
  name: string;
  args: Record<string, unknown>;
}

export function initialLoopState(
  provider: "anthropic" | "openai" | "openrouter",
  system: string,
  prompt: string,
): LoopState {
  if (provider === "anthropic") {
    return { kind: "anthropic", messages: [{ role: "user", content: prompt }] };
  }
  if (provider === "openrouter") {
    return {
      kind: "openrouter",
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    };
  }
  return { kind: "openai", responseId: null, pending: [] };
}

/** Drop oldest exchanges (never the first user prompt) until the state
 *  serializes under the per-task budget. Whole-exchange granularity keeps
 *  tool_use/tool_result pairing (and Anthropic thinking blocks) intact. */
export function trimLoopState(state: LoopState): LoopState {
  if (state.kind === "openai") return state; // server-side history
  const size = () => JSON.stringify(state).length;
  const head = state.kind === "openrouter" ? 2 : 1; // system+first / first
  while (size() > TASK_STATE_CHAR_BUDGET && state.messages.length > head + 1) {
    // Remove ONE whole exchange after the head: the assistant turn plus ALL
    // of its companion messages (Anthropic: the single tool_result user msg;
    // OpenRouter: one role:"tool" message PER parallel tool call). Splicing a
    // fixed 2 would orphan tool messages and break the API's pairing rules.
    let end = head + 1;
    if (state.kind === "openrouter") {
      while (
        end < state.messages.length &&
        (state.messages[end] as { role?: string }).role === "tool"
      ) {
        end++;
      }
    } else if (
      end < state.messages.length &&
      (state.messages[end] as { role?: string }).role === "user"
    ) {
      end++; // the paired tool_result user message
    }
    state.messages.splice(head, end - head);
  }
  return state;
}

export interface ResearchTurnResult {
  state: LoopState;
  /** True when the model produced no tool calls — research is finished. */
  done: boolean;
  toolUses: number;
}

// ---------------------------------------------------------------------------
// Research turns (tools attached, no output schema).
// ---------------------------------------------------------------------------
const WRAP_UP_MSG =
  "IMPORTANT: your research budget is nearly exhausted. STOP calling tools now and write your final deliverable (the brief/memo) as plain text in your next reply.";

export async function runResearchTurn(opts: {
  provider: "anthropic" | "openai" | "openrouter";
  model: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  system: string;
  prompt: string;
  state: LoopState;
  session: BrowserHandle;
  /** Two turns before the phase cap the engine sets this — the agent gets
   *  told to finish instead of dying mid-research on the budget. */
  wrapUp?: boolean;
}): Promise<ResearchTurnResult> {
  if (opts.wrapUp) injectWrapUp(opts.state);
  if (opts.state.kind === "anthropic") return anthropicTurn(opts, opts.state);
  if (opts.state.kind === "openrouter") return openrouterResearch(opts, opts.state);
  return openaiTurn(opts, opts.state);
}

function injectWrapUp(state: LoopState): void {
  // Idempotent-ish: skip if the last user-visible message already nags.
  const marker = "research budget is nearly exhausted";
  if (state.kind === "anthropic") {
    const last = JSON.stringify(state.messages[state.messages.length - 1] ?? "");
    if (!last.includes(marker)) {
      state.messages.push({ role: "user", content: WRAP_UP_MSG });
    }
  } else if (state.kind === "openrouter") {
    const last = JSON.stringify(state.messages[state.messages.length - 1] ?? "");
    if (!last.includes(marker)) {
      state.messages.push({ role: "user", content: WRAP_UP_MSG });
    }
  } else {
    state.wrapUpPending = true; // consumed by the next openaiTurn input
  }
}

async function anthropicTurn(
  opts: {
    model: string;
    effort?: string;
    system: string;
    session: BrowserHandle;
  },
  state: Extract<LoopState, { kind: "anthropic" }>,
): Promise<ResearchTurnResult> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const tools: Anthropic.Tool[] = BROWSER_TOOL_DEFS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as unknown as Anthropic.Tool.InputSchema,
  }));
  const params = {
    model: opts.model,
    max_tokens: 32000,
    thinking: { type: "adaptive" as const },
    system: opts.system,
    ...(opts.effort ? { output_config: { effort: opts.effort } } : {}),
    tools,
    messages: state.messages,
  };
  const response = FABLE_MODELS.test(opts.model)
    ? ((await client.beta.messages.create({
        ...(params as unknown as Record<string, unknown>),
        betas: ["server-side-fallback-2026-06-01"],
        fallbacks: [{ model: "claude-opus-4-8" }],
      } as unknown as Parameters<typeof client.beta.messages.create>[0])) as unknown as Anthropic.Message)
    : await client.messages.create(params as Anthropic.MessageCreateParamsNonStreaming);

  if (response.stop_reason === "refusal") {
    throw new UserFacingError("The model declined this research task.");
  }
  if (response.stop_reason === "max_tokens") {
    throw new UserFacingError(
      "The research turn ran over the output limit — retried automatically.",
    );
  }

  const toolUses = response.content.filter((b) => b.type === "tool_use");
  // Echo the full content back (thinking blocks unchanged — replay rule).
  state.messages.push({ role: "assistant", content: response.content });
  if (toolUses.length === 0) {
    state.lastText = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    return { state: trimLoopState(state), done: true, toolUses: 0 };
  }
  const results: Anthropic.ToolResultBlockParam[] = [];
  for (const tu of toolUses) {
    const output = await execBrowserTool(
      opts.session,
      tu.name,
      (tu.input ?? {}) as Record<string, unknown>,
    );
    results.push({ type: "tool_result", tool_use_id: tu.id, content: output });
  }
  state.messages.push({ role: "user", content: results });
  return { state: trimLoopState(state), done: false, toolUses: toolUses.length };
}

async function openaiTurn(
  opts: {
    model: string;
    effort?: "low" | "medium" | "high" | "xhigh" | "max";
    system: string;
    prompt: string;
    session: BrowserHandle;
  },
  state: Extract<LoopState, { kind: "openai" }>,
): Promise<ResearchTurnResult> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const tools = BROWSER_TOOL_DEFS.map((t) => ({
    type: "function" as const,
    name: t.name,
    description: t.description,
    parameters: t.parameters as Record<string, unknown>,
    strict: true,
  }));

  // Execute any tool calls left pending from the previous turn FIRST, so
  // their outputs ride into this request (server-side history via store).
  let input: string | OpenAI.Responses.ResponseInput;
  if (state.responseId && state.pending.length > 0) {
    const outputs: OpenAI.Responses.ResponseInputItem[] = [];
    for (const call of state.pending) {
      const output = await execBrowserTool(opts.session, call.name, call.args);
      outputs.push({
        type: "function_call_output",
        call_id: call.callId,
        output,
      });
    }
    if (state.wrapUpPending) {
      outputs.push({ role: "user", content: WRAP_UP_MSG });
      state.wrapUpPending = false;
    }
    input = outputs;
  } else {
    input = state.wrapUpPending ? `${opts.prompt}\n\n${WRAP_UP_MSG}` : opts.prompt;
    state.wrapUpPending = false;
  }

  const response = await client.responses.create({
    model: opts.model,
    // instructions are NOT carried over by previous_response_id — resend on
    // every request or later turns run without a system prompt.
    instructions: opts.system,
    ...(state.responseId ? { previous_response_id: state.responseId } : {}),
    input,
    tools,
    store: true,
    ...(opts.effort
      ? { reasoning: { effort: clampOpenAIEffort(opts.effort) } }
      : {}),
  });

  state.responseId = response.id;
  state.lastText = response.output_text ?? state.lastText;
  const calls = (response.output ?? []).flatMap((item) =>
    item.type === "function_call"
      ? [
          {
            callId: item.call_id,
            name: item.name,
            args: safeParse(item.arguments),
          },
        ]
      : [],
  );
  state.pending = calls;
  return { state, done: calls.length === 0, toolUses: calls.length };
}

async function openrouterResearch(
  opts: { model: string; session: BrowserHandle },
  state: Extract<LoopState, { kind: "openrouter" }>,
): Promise<ResearchTurnResult> {
  const tools: ORTool[] = BROWSER_TOOL_DEFS.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters as Record<string, unknown>,
    },
  }));
  const turn = await openrouterTurn({
    model: opts.model,
    messages: state.messages,
    tools,
  });
  state.messages.push(
    turn.assistantMessage as unknown as ORMessage,
  );
  if (turn.toolCalls.length === 0) {
    state.lastText = turn.text;
    return { state: trimLoopState(state), done: true, toolUses: 0 };
  }
  for (const call of turn.toolCalls) {
    const output = await execBrowserTool(opts.session, call.name, call.args);
    state.messages.push({
      role: "tool",
      tool_call_id: call.id,
      content: output,
    });
  }
  return {
    state: trimLoopState(state),
    done: false,
    toolUses: turn.toolCalls.length,
  };
}

function safeParse(raw: string | null | undefined): Record<string, unknown> {
  try {
    return JSON.parse(raw || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Synthesis — no tools, enforced schema. Sync for Anthropic/OpenRouter;
// the OpenAI path is a BACKGROUND pro-mode job (submit + poll, design-chain
// style) because Pro-tier calls are never made synchronously.
// ---------------------------------------------------------------------------
export async function runSynthesisSync(opts: {
  provider: "anthropic" | "openrouter";
  model: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  system: string;
  prompt: string;
  schemaName: string;
  schema: Record<string, unknown>;
}): Promise<unknown> {
  if (opts.provider === "anthropic") {
    // Anthropic compiles the output schema into a constrained-decoding
    // grammar with a hard size limit ("The compiled grammar is too large").
    // Degrade exactly like src/lib/ai/server.ts: enforced schema first,
    // then a prompt-embedded schema + parse.
    try {
      return await anthropicSynthesisAttempt(opts, true);
    } catch (err) {
      if (!isGrammarTooLarge(err)) throw err;
      return await anthropicSynthesisAttempt(opts, false);
    }
  }
  const turn = await openrouterTurn({
    model: opts.model,
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.prompt },
    ],
    schemaName: opts.schemaName,
    schema: opts.schema,
  });
  return parseLastJSON([turn.text]);
}

async function anthropicSynthesisAttempt(
  opts: {
    model: string;
    effort?: "low" | "medium" | "high" | "xhigh" | "max";
    system: string;
    prompt: string;
    schema: Record<string, unknown>;
  },
  enforceFormat: boolean,
): Promise<unknown> {
  {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const system = enforceFormat
      ? opts.system
      : `${opts.system}\n\nRespond with ONLY a single valid JSON object exactly matching this JSON Schema — no prose, no markdown fences:\n${JSON.stringify(opts.schema)}`;
    const params = {
      model: opts.model,
      max_tokens: 32000,
      thinking: { type: "adaptive" as const },
      system,
      output_config: {
        ...(opts.effort ? { effort: opts.effort } : {}),
        ...(enforceFormat
          ? { format: { type: "json_schema" as const, schema: opts.schema } }
          : {}),
      },
      messages: [{ role: "user" as const, content: opts.prompt }],
    };
    const response = FABLE_MODELS.test(opts.model)
      ? ((await client.beta.messages.create({
          ...(params as unknown as Record<string, unknown>),
          betas: ["server-side-fallback-2026-06-01"],
          fallbacks: [{ model: "claude-opus-4-8" }],
        } as unknown as Parameters<typeof client.beta.messages.create>[0])) as unknown as Anthropic.Message)
      : await client.messages.create(params as Anthropic.MessageCreateParamsNonStreaming);
    if (response.stop_reason === "refusal") {
      throw new UserFacingError("The model declined the synthesis step.");
    }
    if (response.stop_reason === "max_tokens") {
      throw new UserFacingError(
        "Synthesis ran over the output limit — retried automatically.",
      );
    }
    return parseLastJSON(
      response.content.filter((b) => b.type === "text").map((b) => b.text),
    );
  }
}

/** Submit the OpenAI pro-mode background synthesis; returns the response id
 *  to poll. `store:true` is REQUIRED for background mode. */
export async function openaiSynthesisSubmit(opts: {
  model: string;
  system: string;
  prompt: string;
  schemaName: string;
  schema: Record<string, unknown>;
}): Promise<string> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const base = {
    model: opts.model,
    instructions: opts.system,
    input: opts.prompt,
    background: true,
    store: true,
    text: {
      format: {
        type: "json_schema" as const,
        name: opts.schemaName,
        strict: true,
        schema: opts.schema,
      },
    },
  };
  try {
    const response = await client.responses.create({
      ...base,
      ...({ reasoning: { mode: "pro" } } as Record<string, unknown>),
    } as OpenAI.Responses.ResponseCreateParamsNonStreaming);
    return response.id;
  } catch (err) {
    // If this deployment's API rejects the pro-mode param shape, degrade to
    // the strongest standard-mode effort rather than bricking synthesis.
    if (
      err instanceof OpenAI.APIError &&
      err.status === 400 &&
      /mode|reasoning/i.test(err.message)
    ) {
      const response = await client.responses.create({
        ...base,
        reasoning: { effort: "xhigh" },
      } as OpenAI.Responses.ResponseCreateParamsNonStreaming);
      return response.id;
    }
    throw err;
  }
}

export type BackgroundPoll =
  | { status: "pending" }
  | { status: "done"; json: unknown }
  | { status: "failed"; error: string }
  | { status: "expired" };

export async function openaiSynthesisPoll(id: string): Promise<BackgroundPoll> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  let response: OpenAI.Responses.Response;
  try {
    response = await client.responses.retrieve(id);
  } catch (err) {
    if (err instanceof OpenAI.APIError && err.status === 404) {
      return { status: "expired" }; // result aged out — resubmit within budget
    }
    throw err;
  }
  if (response.status === "queued" || response.status === "in_progress") {
    return { status: "pending" };
  }
  if (response.status === "completed") {
    try {
      return {
        status: "done",
        json: parseLastJSON(
          response.output_text ? [response.output_text] : [],
        ),
      };
    } catch {
      return { status: "failed", error: "Synthesis returned unparseable output." };
    }
  }
  return {
    status: "failed",
    error: `Background synthesis ${response.status}: ${
      response.incomplete_details?.reason ?? response.error?.message ?? "unknown"
    }`,
  };
}

/** Sync OpenAI synthesis (STANDARD mode — used by the Sol-thinking scorer;
 *  pro mode is background-only via openaiSynthesisSubmit/Poll above). */
export async function openaiSynthesisSync(opts: {
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  system: string;
  prompt: string;
  schemaName: string;
  schema: Record<string, unknown>;
}): Promise<unknown> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await client.responses.create({
    model: opts.model,
    instructions: opts.system,
    input: opts.prompt,
    reasoning: { effort: clampOpenAIEffort(opts.effort) },
    text: {
      format: {
        type: "json_schema",
        name: opts.schemaName,
        strict: true,
        schema: opts.schema,
      },
    },
  });
  if (response.status === "incomplete") {
    throw new UserFacingError(
      `Scoring stopped early (${response.incomplete_details?.reason ?? "unknown"}).`,
    );
  }
  return parseLastJSON(response.output_text ? [response.output_text] : []);
}
