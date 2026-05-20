import type { ZodTypeAny, z } from "zod";

import { budgetFor, estimatePromptTokens, markModelCooldown } from "./token-budget";
import {
  LlmProviderError,
  type ChatJsonOptions,
  type ChatMessage,
  type LlmProvider,
} from "./types";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

interface OpenRouterResponse {
  choices?: Array<{
    message?: { content?: string };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: { message?: string; type?: string; code?: number };
}

/**
 * OpenRouter chat-completions adapter.
 *
 * OpenRouter speaks the OpenAI wire format, so this is structurally
 * identical to GroqProvider — same JSON-mode request, same response
 * shape, same token-budget gating, same fail-fast 429 behaviour.
 *
 * The two recommended headers (`HTTP-Referer` and `X-Title`) are
 * optional but they help OpenRouter attribute usage; we send a stable
 * placeholder so the requests are identifiable in dashboards.
 */
export class OpenRouterProvider implements LlmProvider {
  readonly name = "openrouter";
  readonly model: string;
  private readonly apiKey: string;

  constructor(opts: { apiKey: string; model: string }) {
    if (!opts.apiKey) {
      throw new LlmProviderError(
        "OPENROUTER_API_KEY is not set",
        undefined,
        "openrouter",
      );
    }
    if (!opts.model) {
      throw new LlmProviderError(
        "OpenRouter model is required — set OPENROUTER_MODEL_<PURPOSE> or OPENROUTER_MODEL in env",
        undefined,
        "openrouter",
      );
    }
    this.apiKey = opts.apiKey;
    this.model = opts.model;
  }

  async chatJson<TSchema extends ZodTypeAny>(
    messages: ChatMessage[],
    schema: TSchema,
    options: ChatJsonOptions = {},
  ): Promise<z.infer<TSchema>> {
    const timeoutMs = options.timeoutMs ?? 25_000;
    const maxTokens = options.maxTokens ?? 600;

    // Same token-budget throttle as Groq, keyed by model. OpenRouter
    // free-tier limits vary per model; the conservative default cap
    // ensures we never burst.
    const budget = budgetFor(this.model);
    const promptTokens = estimatePromptTokens(messages);
    const estimatedTotal = promptTokens + maxTokens;
    await budget.reserve(estimatedTotal);

    const attempt = async (msgs: ChatMessage[], retryCount = 0): Promise<string> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(OPENROUTER_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
            "HTTP-Referer": "https://tradeflow.local",
            "X-Title": "TradeFlow",
          },
          body: JSON.stringify({
            model: this.model,
            messages: msgs,
            temperature: options.temperature ?? 0.2,
            max_tokens: maxTokens,
            response_format: { type: "json_object" },
          }),
          signal: controller.signal,
        });

        if (!res.ok) {
          const text = await res.text().catch(() => "");
          if (res.status === 429) {
            const retryAfter = parseFloat(
              res.headers.get("retry-after") ?? "",
            );
            if (Number.isFinite(retryAfter) && retryAfter > 0) {
              markModelCooldown(this.model, retryAfter);
            }
            console.warn(
              `[LLM] openrouter 429 on ${this.model} — cooldown ${Number.isFinite(retryAfter) ? `${retryAfter.toFixed(0)}s` : "unknown"}`,
            );
            throw new LlmProviderError(
              `OpenRouter rate limit on ${this.model}`,
              { status: 429, retryAfterSec: retryAfter, body: text },
              this.name,
            );
          }
          // 404 "no endpoints found" means OpenRouter has no free-tier
          // provider routing this model right now. It's not coming back in
          // the next few seconds — cool it down for 30 min so the chain
          // moves to the next link instead of round-tripping a dead route.
          if (res.status === 404 && /no endpoints found/i.test(text)) {
            markModelCooldown(this.model, 30 * 60);
          }
          console.error(
            `[LLM] openrouter HTTP ${res.status} on ${this.model} — ${(text || res.statusText).slice(0, 400)}`,
          );
          throw new LlmProviderError(
            `OpenRouter HTTP ${res.status} on ${this.model}: ${(text || res.statusText).slice(0, 200)}`,
            { status: res.status, model: this.model, body: text },
            this.name,
          );
        }

        const json = (await res.json()) as OpenRouterResponse;
        if (json.error) {
          throw new LlmProviderError(
            `OpenRouter error: ${json.error.message ?? "unknown"}`,
            json.error,
            this.name,
          );
        }
        const content = json.choices?.[0]?.message?.content;
        if (!content) {
          throw new LlmProviderError(
            "OpenRouter returned an empty completion",
            json,
            this.name,
          );
        }
        const actual = json.usage?.total_tokens;
        if (actual && retryCount === 0) {
          budget.recordActual(estimatedTotal, actual);
        }
        return content;
      } finally {
        clearTimeout(timer);
      }
    };

    const parseAndValidate = (raw: string) => {
      let parsed: unknown;
      try {
        // Some OpenRouter free models wrap JSON in ```json fences. Strip
        // them defensively — the response_format flag is best-effort and
        // not enforced as strictly as Groq's.
        const cleaned = raw
          .replace(/^\s*```(?:json)?\s*/i, "")
          .replace(/\s*```\s*$/i, "")
          .trim();
        parsed = JSON.parse(cleaned);
      } catch (err) {
        throw new LlmProviderError(
          "OpenRouter returned non-JSON",
          err,
          this.name,
        );
      }
      const result = schema.safeParse(parsed);
      if (!result.success) {
        throw new LlmProviderError(
          `OpenRouter response failed schema validation: ${result.error.message}`,
          result.error,
          this.name,
        );
      }
      return result.data as z.infer<TSchema>;
    };

    try {
      const raw = await attempt(messages);
      return parseAndValidate(raw);
    } catch (err) {
      if (!(err instanceof LlmProviderError)) throw err;
      if (
        err.message.startsWith("OpenRouter HTTP") ||
        err.message.startsWith("OpenRouter error") ||
        err.message.startsWith("OpenRouter rate")
      ) {
        throw err;
      }
      const retryMessages: ChatMessage[] = [
        ...messages,
        {
          role: "user",
          content:
            "Your previous reply could not be parsed. Respond again with ONLY a single JSON object matching the schema, no prose, no markdown fences.",
        },
      ];
      const raw = await attempt(retryMessages);
      return parseAndValidate(raw);
    }
  }
}
