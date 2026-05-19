"use server";

import { getSymbolSentiment } from "@/services/sentiment";
import type { SentimentInput } from "@/services/ai/schemas";

export interface SentimentResponse {
  ok: boolean;
  sentiment?: SentimentInput;
  error?: string;
}

/**
 * Server action: fetch fused sentiment for a symbol.
 *
 * Used by the decision subscriber to enrich the LLM input. Returns
 * `{ ok: true, sentiment: undefined }` when no sources were configured or
 * all sources failed — the subscriber treats this as "skip sentiment" rather
 * than as an error.
 */
export async function getSentiment(symbol: string): Promise<SentimentResponse> {
  try {
    const sentiment = await getSymbolSentiment(symbol);
    return { ok: true, sentiment };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Unknown sentiment error",
    };
  }
}
