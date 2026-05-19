import type { ZodTypeAny, z } from "zod";

import {
  LlmProviderError,
  type ChatJsonOptions,
  type ChatMessage,
  type LlmProvider,
} from "./types";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const DEFAULT_MODEL = "llama-3.1-8b-instant";

interface GroqChatResponse {
  choices?: Array<{
    message?: { content?: string };
    finish_reason?: string;
  }>;
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

  constructor(opts: { apiKey: string; model?: string }) {
    if (!opts.apiKey) {
      throw new LlmProviderError("GROQ_API_KEY is not set", undefined, "groq");
    }
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? DEFAULT_MODEL;
  }

  async chatJson<TSchema extends ZodTypeAny>(
    messages: ChatMessage[],
    schema: TSchema,
    options: ChatJsonOptions = {},
  ): Promise<z.infer<TSchema>> {
    const timeoutMs = options.timeoutMs ?? 20_000;

    const attempt = async (msgs: ChatMessage[]) => {
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
          throw new LlmProviderError(
            `Groq HTTP ${res.status}: ${text || res.statusText}`,
            undefined,
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
      const raw = await attempt(retryMessages);
      return parseAndValidate(raw);
    }
  }
}
