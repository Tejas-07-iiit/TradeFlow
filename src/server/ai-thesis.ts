"use server";

import { submitThesisJob } from "@/services/ai/orchestrator";
import {
  ThesisInputSchema,
  type ThesisInput,
} from "@/services/ai/schemas";

export interface ThesisResponse {
  ok: boolean;
  /** ISO timestamp of when the thesis was generated (cached or fresh). */
  generatedAt?: string;
  provider?: string;
  model?: string;
  thesis?: {
    marketBias: string;
    confidence: number;
    setupQuality: string;
    summary: string;
    riskCommentary: string;
    tradeThesis: string;
  };
  error?: string;
}

/**
 * Server action: ask the LLM for a market thesis on the supplied snapshot.
 *
 * Validates the input on the server (don't trust the client to enforce
 * schemas) and returns a flat, plain-JSON-safe response. The provider's API
 * key never crosses the RSC boundary.
 *
 * Returns `{ ok: false, error }` on failure rather than throwing — the client
 * subscriber treats a failed call as "leave the last thesis in place" and
 * doesn't propagate the error to a noisy toast.
 */
export async function getMarketThesis(
  input: ThesisInput,
): Promise<ThesisResponse> {
  const parsed = ThesisInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: `Invalid input: ${parsed.error.message}` };
  }

  const jobResult = await submitThesisJob(parsed.data);
  if (!jobResult.ok || !jobResult.thesis) {
    return {
      ok: false,
      error: jobResult.error ?? "LLM generation failed (see server logs)",
    };
  }

  const result = jobResult.thesis;
  return {
    ok: true,
    generatedAt: result.generatedAt,
    provider: result.provider,
    model: result.model,
    thesis: result.thesis,
  };
}
