/**
 * Provider-agnostic chat interface for the LLM reasoning layer.
 *
 * Any backend (Groq, OpenRouter, Gemini, Anthropic) implements this so the
 * reasoning orchestrator stays vendor-neutral. Adapters are responsible for
 * coercing their native response shape into a parsed JSON object that matches
 * the caller's Zod schema.
 */

import type { ZodTypeAny, z } from "zod";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatJsonOptions {
  /** Soft upper bound on completion tokens. Providers may clamp lower. */
  maxTokens?: number;
  /** 0 = deterministic, ~1 = creative. We default to 0.2 for analyst output. */
  temperature?: number;
  /** Total wallclock budget for the request, including retries. */
  timeoutMs?: number;
}

export interface LlmProvider {
  /** Stable identifier, used for logging and cache busting on provider swaps. */
  readonly name: string;
  /** Model identifier the adapter will route the request to. */
  readonly model: string;
  /**
   * Optional sub-account id (e.g. Groq key #1 vs #2). When present, log
   * formatters render `${name}#${accountId}/${model}` so multi-account
   * chains are readable. Single-account providers omit this.
   */
  readonly accountId?: number;

  /**
   * Send a chat completion that MUST return JSON parseable into `schema`.
   * Implementations should set the provider's structured-output mode (e.g.
   * Groq's `response_format: { type: "json_object" }`) and parse + validate
   * before returning.
   *
   * Throws on:
   *  - transport / auth failures
   *  - JSON parse failures the adapter couldn't recover from
   *  - schema validation failures
   */
  chatJson<TSchema extends ZodTypeAny>(
    messages: ChatMessage[],
    schema: TSchema,
    options?: ChatJsonOptions,
  ): Promise<z.infer<TSchema>>;
}

export class LlmProviderError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
    readonly provider?: string,
  ) {
    super(message);
    this.name = "LlmProviderError";
  }
}
