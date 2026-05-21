/**
 * Pipeline executor.
 *
 * Implements job routing, key load balancing, and exponential backoff retries
 * for decisions, theses, and news classification.
 */

import { getMarketDecisionFor } from "../reasoning/market-decision";
import { getMarketThesisFor } from "../reasoning/market-thesis";
import { classifyNewsItemsLLM } from "../news-validator";
import type { AnalysisJob, JobResult } from "./types";
import { selectBestKey } from "./state";
import type { Scheduler } from "./scheduler";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function executeDecisionJob(
  job: AnalysisJob,
  scheduler: Scheduler,
): Promise<JobResult> {
  const startedAt = Date.now();

  // Abort check before we do any work
  if (job.abortSignal?.aborted) {
    return {
      ok: false,
      error: "Job aborted before pipeline start",
      source: "aborted",
      durationMs: Date.now() - startedAt,
    };
  }

  let attempt = 0;
  const maxAttempts = 3;
  let backoffMs = 2000;
  let lastError: any = null;

  while (attempt < maxAttempts) {
    if (job.abortSignal?.aborted) {
      return {
        ok: false,
        error: "Job aborted during execution",
        source: "aborted",
        durationMs: Date.now() - startedAt,
      };
    }

    // Resolve purpose model to select the best key
    let purpose: "decision" | "thesis" | "news" = "decision";
    if (job.kind === "thesis") purpose = "thesis";
    if (job.kind === "news") purpose = "news";

    const defaultModel =
      purpose === "decision"
        ? process.env.GROQ_MODEL_DECISION
        : purpose === "thesis"
        ? process.env.GROQ_MODEL_THESIS
        : process.env.GROQ_MODEL_NEWS;
    const model = defaultModel || process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

    const preferredAccountId = selectBestKey(model);

    try {
      if (job.kind === "decision") {
        const cached = await getMarketDecisionFor(job.payload, preferredAccountId, false);
        if (!cached) {
          throw new Error("Pipeline returned empty decision");
        }
        return {
          ok: true,
          decision: cached,
          source: cached.source,
          durationMs: Date.now() - startedAt,
        };
      } else if (job.kind === "thesis") {
        const cached = await getMarketThesisFor(job.payload, preferredAccountId, false);
        if (!cached) {
          throw new Error("Pipeline returned empty thesis");
        }
        return {
          ok: true,
          thesis: cached,
          source: "llm",
          durationMs: Date.now() - startedAt,
        };
      } else if (job.kind === "news") {
        const verdicts = await classifyNewsItemsLLM(
          job.symbol,
          job.coinName,
          job.items,
          preferredAccountId,
          false,
        );
        return {
          ok: true,
          verdicts: verdicts || [],
          source: "llm",
          durationMs: Date.now() - startedAt,
        };
      }
    } catch (err: any) {
      lastError = err;
      const is429 =
        err?.status === 429 ||
        err?.message?.includes("rate limit") ||
        err?.message?.includes("429") ||
        err?.message?.includes("budget exhausted") ||
        err?.message?.includes("Token budget exhausted");

      if (is429) {
        attempt++;
        if (attempt < maxAttempts) {
          console.warn(
            `[orch/pipeline] Job ${job.kind} ${job.symbol} rate limited (429) — retrying attempt ${attempt}/${maxAttempts} in ${backoffMs}ms`,
          );
          scheduler.recordRetry();
          await sleep(backoffMs);
          backoffMs *= 2;
          continue;
        }
      }
      break;
    }
  }

  // All attempts failed. Hand over to fallback engine (with fallback allowed = true)
  console.warn(
    `[orch/pipeline] Job ${job.kind} ${job.symbol} all attempts failed. Final error: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }. Executing fallback.`,
  );

  try {
    if (job.kind === "decision") {
      const fallback = await getMarketDecisionFor(job.payload, undefined, true);
      return {
        ok: true,
        decision: fallback || undefined,
        source: fallback?.source || "local-fallback",
        durationMs: Date.now() - startedAt,
      };
    } else if (job.kind === "thesis") {
      const fallback = await getMarketThesisFor(job.payload, undefined, true);
      return {
        ok: fallback != null,
        thesis: fallback || undefined,
        source: fallback ? "llm" : undefined,
        durationMs: Date.now() - startedAt,
      };
    } else if (job.kind === "news") {
      const fallback = await classifyNewsItemsLLM(
        job.symbol,
        job.coinName,
        job.items,
        undefined,
        true,
      );
      return {
        ok: true,
        verdicts: fallback || [],
        source: fallback ? "llm" : "prefilter",
        durationMs: Date.now() - startedAt,
      };
    }
  } catch (err: any) {
    return {
      ok: false,
      error: `Fallback crashed: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - startedAt,
    };
  }

  return {
    ok: false,
    error: `Job execution failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    durationMs: Date.now() - startedAt,
  };
}
