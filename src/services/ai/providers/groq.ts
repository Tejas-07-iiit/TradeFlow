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
  /**
   * Stable id of the Groq account this instance is bound to (1-based,
   * matching the env var suffix: `GROQ_API_KEY` → 1, `GROQ_API_KEY_2` → 2,
   * etc.). Surfaces in logs and keys the TPM/cooldown trackers so the two
   * accounts don't share one local bucket.
   */
  readonly accountId: number;
  private readonly apiKey: string;

  constructor(opts: { apiKey: string; model: string; accountId?: number }) {
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
    this.accountId = opts.accountId ?? 1;
  }

  private get logLabel(): string {
    return `${this.model}#${this.accountId}`;
  }

  async chatJson<TSchema extends ZodTypeAny>(
    messages: ChatMessage[],
    schema: TSchema,
    options: ChatJsonOptions = {},
  ): Promise<z.infer<TSchema>> {
    const timeoutMs = options.timeoutMs ?? 20_000;
    const maxTokens = options.maxTokens ?? 600;

    // PREFLIGHT: Message validation
    if (!messages || messages.length === 0) {
      throw new LlmProviderError("Preflight failed: messages array is empty", undefined, this.name);
    }
    if (messages.some(m => !m.content || m.content.trim() === "")) {
      throw new LlmProviderError("Preflight failed: one or more messages have empty content", undefined, this.name);
    }

    // PREFLIGHT: Capability Negotiation
    const { getModelCapability } = require("../orchestrator/state");
    const modelCap = getModelCapability(this.model);
    const supportsJsonMode = modelCap.supportsJson;

    // Reserve against the per-model sliding-60s token bucket BEFORE we
    // open the HTTP socket. If the budget is exhausted, throw without
    // contacting Groq — saves the round trip and the 429 log noise.
    // We reserve a realistic output budget (~40% of maxTokens, capped at
    // 800) rather than the full maxTokens cap; otherwise 2 concurrent
    // decision calls reserve 4K of output tokens and exhaust the local
    // budget while Groq sees only ~1.5K actual usage. After the response
    // lands, recordActual replaces the estimate with truth.
    // Per-(account, model) budget so two Groq accounts track independently:
    // exhausting key #1 no longer blocks key #2 from serving the same model.
    const budget = budgetFor(this.model, this.accountId);
    const promptTokens = estimatePromptTokens(messages);
    const reservedOutput = Math.min(maxTokens, Math.max(400, Math.ceil(maxTokens * 0.4)));
    const estimatedTotal = promptTokens + reservedOutput;
    const reservation = await budget.reserve(estimatedTotal);

    const {
      recordRequestStart,
      recordRequestEnd,
      recordRequestFailure,
      record429Event,
    } = require("../orchestrator/state");

    recordRequestStart(this.accountId, estimatedTotal);
    const startMs = Date.now();
    let actualTokens: number | undefined;

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
            ...(supportsJsonMode ? { response_format: { type: "json_object" } } : {}),
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
              markModelCooldown(this.model, retryAfter, this.accountId);
            }
            const isTpd = /tokens per day|TPD/i.test(text);
            console.warn(
              `[LLM] groq 429 on ${this.logLabel} — ${isTpd ? "daily quota" : "rate limit"}; cooldown ${Number.isFinite(retryAfter) ? `${retryAfter.toFixed(0)}s` : "unknown"}`,
            );
            
            // Record 429 event in tracker
            record429Event(
              this.accountId,
              this.model,
              Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 60,
              isTpd,
              text.slice(0, 300) || "Rate limited",
            );

            throw new LlmProviderError(
              `Groq rate limit on ${this.logLabel}`,
              { status: 429, retryAfterSec: retryAfter, body: text, tpd: isTpd, accountId: this.accountId },
              this.name,
            );
          }
          const isJsonValidateFailed =
            res.status === 400 && /json_validate_failed/i.test(text);
          if (isJsonValidateFailed) {
            const failedGen = extractFailedGeneration(text);
            throw new LlmProviderError(
              `Groq json_validate_failed on ${this.logLabel}`,
              {
                status: 400,
                code: "json_validate_failed",
                model: this.model,
                accountId: this.accountId,
                body: text,
                failedGeneration: failedGen,
              },
              this.name,
            );
          }
          console.error(
            `[LLM] groq HTTP ${res.status} on ${this.logLabel} — Full Body: ${text}`,
          );
          throw new LlmProviderError(
            `Groq HTTP ${res.status} on ${this.logLabel}: ${text}`,
            { status: res.status, model: this.model, body: text, accountId: this.accountId },
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
        const actual = json.usage?.total_tokens;
        if (actual) {
          actualTokens = actual;
          if (retryCount === 0) {
            budget.recordActual(reservation, actual);
          }
        }
        return content;
      } finally {
        clearTimeout(timer);
      }
    };

    const parseAndValidate = (raw: string) => {
      let parsed: unknown;
      try {
        // Aggressively strip markdown code blocks if present (e.g. ```json ... ```)
        const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
        const sanitizedRaw = jsonMatch ? jsonMatch[1].trim() : raw.trim();
        parsed = JSON.parse(sanitizedRaw);
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
      const data = parseAndValidate(raw);
      const duration = Date.now() - startMs;
      recordRequestEnd(this.accountId, this.model, duration, actualTokens, true);
      return data;
    } catch (err) {
      const isJsonError = err instanceof Error && (err.message.toLowerCase().includes("json") || err.message.toLowerCase().includes("parse"));
      recordRequestFailure(this.accountId, this.model, isJsonError);
      // 429s / network errors meant the call never produced billable
      // usage — release the reservation so the next attempt in the chain
      // doesn't see an inflated window.
      const isLlmErr = err instanceof LlmProviderError;
      const cause = isLlmErr
        ? (err.cause as
            | { status?: number; code?: string; failedGeneration?: string }
            | undefined)
        : undefined;
      if (cause?.status === 429 || (isLlmErr && err.message.includes("Groq error"))) {
        budget.release(reservation);
      }
      if (!isLlmErr) throw err;

      // Groq's own JSON validator rejected the model output (e.g. it
      // emitted an arithmetic expression instead of a finished number).
      // We can repair this in-place by handing the broken text back to
      // the model and asking it to fix it.
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
