import type { ZodTypeAny, z } from "zod";

import { budgetFor, estimatePromptTokens, markModelCooldown } from "./token-budget";
import {
  LlmProviderError,
  type ChatJsonOptions,
  type ChatMessage,
  type LlmProvider,
} from "./types";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

interface GroqChatResponse {
  choices?: Array<{
    message?: { content?: string };
    finish_reason?: string;
  }>;
  /** Groq mirrors OpenAI's `usage` block — total_tokens lets the budget
   *  rate-limiter calibrate against actuals instead of our estimate. */
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: { message?: string; type?: string };
}

/**
 * Groq's OpenAI-compatible chat completions adapter.
 *
 * Uses `response_format: { type: "json_object" }` so the model is constrained
 * to emit a single JSON object — Groq enforces this server-side. We still
 * validate against the caller's Zod schema because providers' JSON mode does
 * not guarantee the *shape* of the JSON, only that it parses.
 *
 * One retry on validation failure with a stricter "JSON only" reminder
 * appended — this catches the common case where a small model wraps its
 * answer in prose.
 */
export class GroqProvider implements LlmProvider {
  readonly name = "groq";
  readonly model: string;
  private readonly apiKey: string;

  constructor(opts: { apiKey: string; model: string }) {
    if (!opts.apiKey) {
      throw new LlmProviderError("GROQ_API_KEY is not set", undefined, "groq");
    }
    if (!opts.model) {
      throw new LlmProviderError(
        "Groq model is required — set GROQ_MODEL_<PURPOSE> or GROQ_MODEL in env",
        undefined,
        "groq",
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
    const timeoutMs = options.timeoutMs ?? 20_000;
    const maxTokens = options.maxTokens ?? 600;

    // Reserve against the per-model sliding-60s token bucket BEFORE we
    // open the HTTP socket. If the budget is exhausted, throw without
    // contacting Groq — saves the round trip and the 429 log noise.
    const budget = budgetFor(this.model);
    const promptTokens = estimatePromptTokens(messages);
    const estimatedTotal = promptTokens + maxTokens;
    await budget.reserve(estimatedTotal);

    const attempt = async (msgs: ChatMessage[], retryCount = 0): Promise<string> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(GROQ_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: this.model,
            messages: msgs,
            temperature: options.temperature ?? 0.2,
            max_tokens: options.maxTokens ?? 600,
            response_format: { type: "json_object" },
          }),
          signal: controller.signal,
        });

        if (!res.ok) {
          const text = await res.text().catch(() => "");
          if (res.status === 429) {
            // Fail fast on rate limit. We used to retry up to 3× with
            // ~30s sleeps each, which blocked the whole engine for
            // 90+ seconds. Better to drop this call, let the round-robin
            // cycle move on, and try the next symbol — by the time we
            // revisit this one the bucket has refilled.
            const retryAfter = parseFloat(
              res.headers.get("retry-after") ?? "",
            );
            // Persist a cooldown for the model so subsequent reservations
            // fail fast instead of round-tripping a guaranteed-429. Groq
            // returns retry-after even for the daily (TPD) cap, which the
            // sliding-60s TPM throttle alone cannot see.
            if (Number.isFinite(retryAfter) && retryAfter > 0) {
              markModelCooldown(this.model, retryAfter);
            }
            const isTpd = /tokens per day|TPD/i.test(text);
            console.warn(
              `[LLM] groq 429 on ${this.model} — ${isTpd ? "daily quota" : "rate limit"}; cooldown ${Number.isFinite(retryAfter) ? `${retryAfter.toFixed(0)}s` : "unknown"}`,
            );
            throw new LlmProviderError(
              `Groq rate limit on ${this.model}`,
              { status: 429, retryAfterSec: retryAfter, body: text, tpd: isTpd },
              this.name,
            );
          }
          // Groq returns 400 with code `json_validate_failed` when the
          // model emitted text that parses as JSON-ish but isn't strict
          // JSON (e.g. an arithmetic expression inside a number field).
          // Surface a typed marker so the outer retry can repair it
          // instead of bailing out to the next provider in the chain.
          const isJsonValidateFailed =
            res.status === 400 && /json_validate_failed/i.test(text);
          if (isJsonValidateFailed) {
            const failedGen = extractFailedGeneration(text);
            throw new LlmProviderError(
              `Groq json_validate_failed on ${this.model}`,
              {
                status: 400,
                code: "json_validate_failed",
                model: this.model,
                body: text,
                failedGeneration: failedGen,
              },
              this.name,
            );
          }
          console.error(
            `[LLM] groq HTTP ${res.status} on ${this.model} — ${(text || res.statusText).slice(0, 400)}`,
          );
          throw new LlmProviderError(
            `Groq HTTP ${res.status} on ${this.model}: ${(text || res.statusText).slice(0, 200)}`,
            { status: res.status, model: this.model, body: text },
            this.name,
          );
        }

        const json = (await res.json()) as GroqChatResponse;
        if (json.error) {
          throw new LlmProviderError(
            `Groq error: ${json.error.message ?? json.error.type ?? "unknown"}`,
            json.error,
            this.name,
          );
        }
        const content = json.choices?.[0]?.message?.content;
        if (!content) {
          throw new LlmProviderError(
            "Groq returned an empty completion",
            json,
            this.name,
          );
        }
        // Calibrate the budget against actual token usage so future calls
        // don't over-reserve on conservative estimates. Only on the first
        // attempt — retries reuse the same reservation.
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
        parsed = JSON.parse(raw);
      } catch (err) {
        throw new LlmProviderError(
          "Groq returned non-JSON despite response_format=json_object",
          err,
          this.name,
        );
      }
      const result = schema.safeParse(parsed);
      if (!result.success) {
        throw new LlmProviderError(
          `Groq response failed schema validation: ${result.error.message}`,
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

      // Groq's own JSON validator rejected the model output (e.g. it
      // emitted an arithmetic expression instead of a finished number).
      // We can repair this in-place by handing the broken text back to
      // the model and asking it to fix it.
      const cause = err.cause as
        | { code?: string; failedGeneration?: string }
        | undefined;
      if (cause?.code === "json_validate_failed") {
        const broken = cause.failedGeneration ?? "";
        const repairMessages: ChatMessage[] = [
          ...messages,
          {
            role: "user",
            content: [
              "Your previous reply failed strict JSON validation. The broken text was:",
              "```",
              broken.slice(0, 2000),
              "```",
              "Common causes: arithmetic expressions like `a - 0.5 * b` inside a number field, trailing comments, NaN, or unfinished values.",
              "Fix it: recompute every number to a single finished decimal literal, then respond with ONLY the corrected JSON object. No prose, no markdown fences, no expressions.",
            ].join("\n"),
          },
        ];
        const raw = await attempt(repairMessages, 1);
        return parseAndValidate(raw);
      }

      // One retry on shape failure with an explicit JSON-only reminder.
      // Transport/auth errors aren't retried — they won't fix themselves
      // by trying again within the same request budget.
      if (
        err.message.startsWith("Groq HTTP") ||
        err.message.startsWith("Groq error")
      ) {
        throw err;
      }
      const retryMessages: ChatMessage[] = [
        ...messages,
        {
          role: "user",
          content:
            "Your previous reply could not be parsed. Respond again with ONLY a single JSON object matching the schema, with no markdown fences or prose.",
        },
      ];
      const raw = await attempt(retryMessages, 1);
      return parseAndValidate(raw);
    }
  }
}

/**
 * Pull the `failed_generation` blob out of Groq's 400 body. It's the
 * raw model output that tripped strict JSON validation, useful to show
 * back to the model on the repair retry.
 */
function extractFailedGeneration(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body);
    const v = parsed?.error?.failed_generation;
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}
