// OpenRouter — third model vendor for the discovery engine's generation
// diversity (DeepSeek / Qwen / Gemini / Llama). Speaks the OpenAI
// chat/completions surface (NOT the Responses API that src/lib/ai/server.ts
// uses for OpenAI itself), via the OpenAI SDK with a baseURL override — the
// officially documented client pattern.
//
// Discovery-only in v1: not reachable from user Settings; every call is
// made by the discovery engine under its own claim/budget protocol.
import OpenAI from "openai";
import { UserFacingError } from "./server";

export function openrouterConfigured(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY);
}

function client(): OpenAI {
  return new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY,
    defaultHeaders: {
      // Optional attribution headers per OpenRouter docs.
      "HTTP-Referer": process.env.NEXT_PUBLIC_APP_URL ?? "",
      "X-OpenRouter-Title": "Unicorn Idea Filter",
    },
  });
}

export type ORMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
export type ORTool = OpenAI.Chat.Completions.ChatCompletionTool;

export interface ORTurnResult {
  /** The assistant message to append to the loop history verbatim. */
  assistantMessage: OpenAI.Chat.Completions.ChatCompletionMessage;
  /** Tool calls the caller must execute (empty = final turn). */
  toolCalls: { id: string; name: string; args: Record<string, unknown> }[];
  text: string;
  usage?: { in: number; cachedIn: number; out: number };
}

/**
 * One chat/completions round-trip for the discovery tool loop. When `schema`
 * is set the turn also carries response_format json_schema so the FINAL
 * (no-tool-call) message is enforced JSON; `require_parameters` makes
 * OpenRouter skip providers that would silently drop json_schema/tools.
 */
export async function openrouterTurn(opts: {
  model: string;
  messages: ORMessage[];
  tools?: ORTool[];
  schemaName?: string;
  schema?: Record<string, unknown>;
  maxTokens?: number;
  /** OpenRouter-normalized reasoning effort (DeepSeek/Qwen/Gemini support
   *  it; omit for models that don't). */
  reasoningEffort?: "low" | "medium" | "high";
  /** "none" forbids tool calls while keeping defs valid for history. */
  toolChoice?: "none";
}): Promise<ORTurnResult> {
  try {
    const response = await client().chat.completions.create({
      model: opts.model,
      messages: opts.messages,
      max_tokens: opts.maxTokens ?? 32_000,
      ...(opts.reasoningEffort
        ? ({ reasoning: { effort: opts.reasoningEffort } } as Record<
            string,
            unknown
          >)
        : {}),
      ...(opts.tools?.length ? { tools: opts.tools } : {}),
      ...(opts.toolChoice ? { tool_choice: opts.toolChoice } : {}),
      ...(opts.schema
        ? {
            response_format: {
              type: "json_schema" as const,
              json_schema: {
                name: opts.schemaName ?? "output",
                strict: true,
                schema: opts.schema,
              },
            },
          }
        : {}),
      // OpenRouter-specific routing preference — the OpenAI SDK passes
      // unknown body fields through; the cast is for TS only.
      ...({ provider: { require_parameters: true } } as Record<
        string,
        unknown
      >),
    } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming);

    const choice = response.choices?.[0];
    if (!choice?.message) {
      throw new UserFacingError(
        "OpenRouter returned an empty response. Try again.",
        502,
      );
    }
    const msg = choice.message;
    const toolCalls = (msg.tool_calls ?? []).flatMap((tc) => {
      if (tc.type !== "function") return [];
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments || "{}") as Record<
          string,
          unknown
        >;
      } catch {
        // Malformed args: surface the parse failure to the model as a tool
        // error rather than crashing the turn.
      }
      return [{ id: tc.id, name: tc.function.name, args }];
    });
    return {
      assistantMessage: msg,
      toolCalls,
      text: msg.content ?? "",
      usage: response.usage
        ? {
            in: response.usage.prompt_tokens ?? 0,
            cachedIn:
              response.usage.prompt_tokens_details?.cached_tokens ?? 0,
            out: response.usage.completion_tokens ?? 0,
          }
        : undefined,
    };
  } catch (err) {
    if (err instanceof UserFacingError) throw err;
    // Errors from the OpenAI SDK here are OPENROUTER failures — never let
    // them masquerade as "OpenAI API key invalid" (the key is different).
    if (err instanceof OpenAI.APIError) {
      if (err.status === 401) {
        throw new UserFacingError(
          "The OpenRouter API key on this deployment is invalid or missing.",
          502,
        );
      }
      if (err.status === 404) {
        throw new UserFacingError(
          `OpenRouter doesn't recognize the model "${opts.model}".`,
          502,
        );
      }
      if (err.status === 429) {
        throw new UserFacingError(
          "OpenRouter is rate-limiting this deployment — retried later automatically.",
          503,
        );
      }
      // OpenRouter wraps upstream failures as "Provider returned error" —
      // the useful part lives in the error body's metadata.
      const body = JSON.stringify(
        (err as { error?: unknown }).error ?? {},
      ).slice(0, 400);
      throw new UserFacingError(
        `OpenRouter error (${err.status ?? "network"}): ${err.message.slice(0, 200)} ${body}`,
        502,
      );
    }
    throw err;
  }
}
