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
  browserToolDefs,
  execBrowserTool,
  type BrowserHandle,
  type ToolOutcome,
} from "./browserbase";
import { TASK_STATE_CHAR_BUDGET } from "./config";

const FABLE_MODELS = /^claude-(fable-5|mythos-5)/;

/** Prompt caching for the append-only research loop: cache_control on the
 *  system prompt and the last message makes every turn a prefix cache hit —
 *  at 400k-token windows this is the difference between ~$4 and ~$0.45 a
 *  turn. Applied at REQUEST time only (never persisted into loop state). */
function cachedSystem(system: string): Anthropic.TextBlockParam[] {
  return [
    { type: "text", text: system, cache_control: { type: "ephemeral" } },
  ];
}
function cachedMessages(
  messages: Anthropic.MessageParam[],
): Anthropic.MessageParam[] {
  if (messages.length === 0) return messages;
  const out = messages.slice();
  const last = out[out.length - 1];
  const content = last.content;
  if (typeof content === "string") {
    out[out.length - 1] = {
      ...last,
      content: [
        { type: "text", text: content, cache_control: { type: "ephemeral" } },
      ],
    };
  } else if (Array.isArray(content) && content.length > 0) {
    const blocks = content.slice();
    const tail = blocks[blocks.length - 1];
    if (typeof tail !== "string") {
      blocks[blocks.length - 1] = {
        ...tail,
        cache_control: { type: "ephemeral" },
      } as (typeof blocks)[number];
    }
    out[out.length - 1] = { ...last, content: blocks };
  }
  return out;
}

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
  | {
      kind: "anthropic";
      messages: Anthropic.MessageParam[];
      lastText?: string;
      /** Model id that started this loop — a loop must FINISH on the model
       *  that started it (mid-loop switches have shipped three 404s). */
      model?: string;
    }
  | {
      kind: "openai";
      responseId: string | null;
      pending: PendingCall[];
      lastText?: string;
      wrapUpPending?: boolean;
      model?: string;
    }
  | { kind: "openrouter"; messages: ORMessage[]; lastText?: string; model?: string };

interface PendingCall {
  callId: string;
  name: string;
  args: Record<string, unknown>;
}

export function initialLoopState(
  provider: "anthropic" | "openai" | "openrouter",
  system: string,
  prompt: string,
  model?: string,
): LoopState {
  if (provider === "anthropic") {
    return {
      kind: "anthropic",
      messages: [{ role: "user", content: prompt }],
      model,
    };
  }
  if (provider === "openrouter") {
    return {
      kind: "openrouter",
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
      model,
    };
  }
  return { kind: "openai", responseId: null, pending: [], model };
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

const SCREENSHOT_PLACEHOLDER =
  "[screenshot was shown here — it has been viewed and pruned from history]";

/** Each screenshot is sent to the model exactly once (the turn after it was
 *  taken), then pruned: base64 images would blow the persisted state budget
 *  and re-billing them every turn buys nothing. Only the LAST user message
 *  (the fresh tool results) keeps its images. */
function stripOldImages(state: LoopState): void {
  if (state.kind === "anthropic") {
    for (let i = 0; i < state.messages.length - 1; i++) {
      const m = state.messages[i];
      if (m.role !== "user" || !Array.isArray(m.content)) continue;
      for (const block of m.content) {
        if (
          typeof block !== "string" &&
          block.type === "tool_result" &&
          Array.isArray(block.content)
        ) {
          block.content = block.content.map((c) =>
            typeof c !== "string" && c.type === "image"
              ? { type: "text" as const, text: SCREENSHOT_PLACEHOLDER }
              : c,
          );
        }
      }
    }
  } else if (state.kind === "openrouter") {
    for (let i = 0; i < state.messages.length - 1; i++) {
      const m = state.messages[i] as { role?: string; content?: unknown };
      if (m.role === "user" && Array.isArray(m.content)) {
        const hasImage = (m.content as Array<{ type?: string }>).some(
          (c) => c.type === "image_url",
        );
        if (hasImage) m.content = SCREENSHOT_PLACEHOLDER;
      }
    }
  }
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
  /** Forced-delivery mode: no tools attached — the model can only write
   *  its deliverable from what it already has. */
  noTools?: boolean;
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

/** Anthropic rejects histories where a tool_use message isn't immediately
 *  followed by matching tool_result blocks. Corrupted states exist in prod
 *  (writer under investigation — likely an interrupted persist); repair by
 *  inserting synthetic results so the loop can continue instead of
 *  hard-400ing on every claim forever. */
function repairToolPairing(
  messages: Anthropic.MessageParam[],
): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    out.push(m);
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    const ids = m.content
      .filter(
        (b): b is Anthropic.ToolUseBlockParam =>
          typeof b !== "string" && b.type === "tool_use",
      )
      .map((b) => b.id);
    if (ids.length === 0) continue;
    const next = messages[i + 1];
    const answered = new Set<string>();
    if (next && next.role === "user" && Array.isArray(next.content)) {
      for (const b of next.content) {
        if (typeof b !== "string" && b.type === "tool_result") {
          answered.add(b.tool_use_id);
        }
      }
    }
    const missing = ids.filter((id) => !answered.has(id));
    if (missing.length === 0) continue;
    console.error(
      `[discovery] repaired ${missing.length} dangling tool_use pair(s) in loop state`,
    );
    const synthetic: Anthropic.ToolResultBlockParam[] = missing.map((id) => ({
      type: "tool_result",
      tool_use_id: id,
      content:
        "[result lost during an interrupted turn — re-run the tool if you still need it]",
    }));
    if (next && next.role === "user" && Array.isArray(next.content)) {
      // Merge into the existing (partial) result message.
      next.content = [...synthetic, ...next.content];
    } else {
      out.push({ role: "user", content: synthetic });
    }
  }
  return out;
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
  state.messages = repairToolPairing(state.messages);
  stripOldImages(state);
  // noTools must NOT drop the defs — history containing tool_use/tool_result
  // blocks is rejected without them; tool_choice none forbids further use.
  const noTools = Boolean((opts as { noTools?: boolean }).noTools);
  const tools: Anthropic.Tool[] = browserToolDefs(
    opts.session.vision ?? false,
  ).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as unknown as Anthropic.Tool.InputSchema,
  }));
  const params = {
    model: opts.model,
    max_tokens: 32000,
    thinking: { type: "adaptive" as const },
    system: cachedSystem(opts.system),
    ...(opts.effort ? { output_config: { effort: opts.effort } } : {}),
    tools,
    ...(noTools ? { tool_choice: { type: "none" as const } } : {}),
    messages: cachedMessages(state.messages),
  };
  // Streamed under the hood: the SDK REQUIRES streaming for requests whose
  // max_tokens imply >10 min of generation ("Streaming is required for
  // operations that may take longer than 10 minutes"), which max-effort
  // 32k-token research turns do. finalMessage() gives the same Message.
  const response = FABLE_MODELS.test(opts.model)
    ? ((await client.beta.messages
        .stream({
          ...(params as unknown as Record<string, unknown>),
          betas: ["server-side-fallback-2026-06-01"],
          fallbacks: [{ model: "claude-opus-4-8" }],
        } as unknown as Parameters<typeof client.beta.messages.stream>[0])
        .finalMessage()) as unknown as Anthropic.Message)
    : await client.messages
        .stream(params as Anthropic.MessageCreateParamsNonStreaming)
        .finalMessage();

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
    const outcome = await execBrowserTool(
      opts.session,
      tu.name,
      (tu.input ?? {}) as Record<string, unknown>,
    );
    results.push({
      type: "tool_result",
      tool_use_id: tu.id,
      content:
        outcome.kind === "text"
          ? outcome.text
          : [
              {
                type: "image" as const,
                source: {
                  type: "base64" as const,
                  media_type: "image/jpeg" as const,
                  data: outcome.dataB64,
                },
              },
              { type: "text" as const, text: outcome.note },
            ],
    });
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
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 900_000 });
  const noTools = Boolean((opts as { noTools?: boolean }).noTools);
  const tools = browserToolDefs(opts.session.vision ?? false).map((t) => ({
    type: "function" as const,
    name: t.name,
    description: t.description,
    parameters: t.parameters as Record<string, unknown>,
    // strict:false — the tool schemas carry OPTIONAL params (search
    // verticals, pagination), which strict mode disallows.
    strict: false,
  }));

  // Execute any tool calls left pending from the previous turn FIRST, so
  // their outputs ride into this request (server-side history via store).
  let input: string | OpenAI.Responses.ResponseInput;
  if (state.responseId && state.pending.length > 0) {
    const outputs: OpenAI.Responses.ResponseInputItem[] = [];
    for (const call of state.pending) {
      const outcome = await execBrowserTool(opts.session, call.name, call.args);
      if (outcome.kind === "text") {
        outputs.push({
          type: "function_call_output",
          call_id: call.callId,
          output: outcome.text,
        });
      } else {
        outputs.push({
          type: "function_call_output",
          call_id: call.callId,
          output: `${outcome.note} — the screenshot follows as the next message.`,
        });
        outputs.push({
          role: "user",
          content: [
            {
              type: "input_image",
              image_url: `data:image/jpeg;base64,${outcome.dataB64}`,
              detail: "high",
            },
          ],
        });
      }
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
    ...(noTools ? { tool_choice: "none" as const } : {}),
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
  opts: {
    model: string;
    session: BrowserHandle;
    effort?: "low" | "medium" | "high" | "xhigh" | "max";
  },
  state: Extract<LoopState, { kind: "openrouter" }>,
): Promise<ResearchTurnResult> {
  stripOldImages(state);
  const noTools = Boolean((opts as { noTools?: boolean }).noTools);
  const tools: ORTool[] = browserToolDefs(opts.session.vision ?? false).map(
    (t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters as Record<string, unknown>,
      },
    }),
  );
  const turn = await openrouterTurn({
    model: opts.model,
    messages: state.messages,
    tools,
    ...(noTools ? { toolChoice: "none" as const } : {}),
    ...(opts.effort
      ? { reasoningEffort: (opts.effort === "max" || opts.effort === "xhigh"
          ? "high"
          : opts.effort) as "low" | "medium" | "high" }
      : {}),
  });
  state.messages.push(
    turn.assistantMessage as unknown as ORMessage,
  );
  if (turn.toolCalls.length === 0) {
    state.lastText = turn.text;
    return { state: trimLoopState(state), done: true, toolUses: 0 };
  }
  for (const call of turn.toolCalls) {
    const outcome = await execBrowserTool(opts.session, call.name, call.args);
    if (outcome.kind === "text") {
      state.messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: outcome.text,
      });
    } else {
      state.messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: `${outcome.note} — the screenshot follows as the next message.`,
      });
      state.messages.push({
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: `data:image/jpeg;base64,${outcome.dataB64}` },
          },
        ],
      });
    }
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
  // Some OpenRouter upstream providers 400 on response_format json_schema
  // despite require_parameters routing — degrade to a prompt-embedded
  // schema + parse, mirroring the Anthropic grammar ladder.
  try {
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
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (!/400/.test(msg)) throw err;
    const turn = await openrouterTurn({
      model: opts.model,
      messages: [
        {
          role: "system",
          content: `${opts.system}\n\nRespond with ONLY a single valid JSON object exactly matching this JSON Schema — no prose, no markdown fences:\n${JSON.stringify(opts.schema)}`,
        },
        { role: "user", content: opts.prompt },
      ],
    });
    return parseLastJSON([turn.text]);
  }
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
      system: cachedSystem(system),
      output_config: {
        ...(opts.effort ? { effort: opts.effort } : {}),
        ...(enforceFormat
          ? { format: { type: "json_schema" as const, schema: opts.schema } }
          : {}),
      },
      messages: [{ role: "user" as const, content: opts.prompt }],
    };
    const response = FABLE_MODELS.test(opts.model)
      ? ((await client.beta.messages
          .stream({
            ...(params as unknown as Record<string, unknown>),
            betas: ["server-side-fallback-2026-06-01"],
            fallbacks: [{ model: "claude-opus-4-8" }],
          } as unknown as Parameters<typeof client.beta.messages.stream>[0])
          .finalMessage()) as unknown as Anthropic.Message)
      : await client.messages
          .stream(params as Anthropic.MessageCreateParamsNonStreaming)
          .finalMessage();
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

/** One plain-text call, no tools, no schema — the critique stage. */
export async function plainTextCall(opts: {
  provider: "anthropic" | "openai" | "openrouter";
  model: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  system: string;
  prompt: string;
}): Promise<string> {
  if (opts.provider === "anthropic") {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const params = {
      model: opts.model,
      max_tokens: 32000,
      thinking: { type: "adaptive" as const },
      system: cachedSystem(opts.system),
      ...(opts.effort ? { output_config: { effort: opts.effort } } : {}),
      messages: [{ role: "user" as const, content: opts.prompt }],
    };
    const response = FABLE_MODELS.test(opts.model)
      ? ((await client.beta.messages
          .stream({
            ...(params as unknown as Record<string, unknown>),
            betas: ["server-side-fallback-2026-06-01"],
            fallbacks: [{ model: "claude-opus-4-8" }],
          } as unknown as Parameters<typeof client.beta.messages.stream>[0])
          .finalMessage()) as unknown as Anthropic.Message)
      : await client.messages
          .stream(params as Anthropic.MessageCreateParamsNonStreaming)
          .finalMessage();
    if (response.stop_reason === "refusal") {
      throw new UserFacingError("The model declined the critique step.");
    }
    return response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  }
  if (opts.provider === "openai") {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 900_000 });
    const response = await client.responses.create({
      model: opts.model,
      instructions: opts.system,
      input: opts.prompt,
      ...(opts.effort
        ? { reasoning: { effort: clampOpenAIEffort(opts.effort) } }
        : {}),
    });
    if (response.status === "incomplete") {
      throw new UserFacingError("The critique step stopped early.");
    }
    return response.output_text ?? "";
  }
  const turn = await openrouterTurn({
    model: opts.model,
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.prompt },
    ],
    ...(opts.effort
      ? { reasoningEffort: (opts.effort === "max" || opts.effort === "xhigh"
          ? "high"
          : opts.effort) as "low" | "medium" | "high" }
      : {}),
  });
  return turn.text;
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
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 900_000 });
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
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 900_000 });
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
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 900_000 });
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
