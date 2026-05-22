import { getMarketDecisionFor } from "../reasoning/market-decision";
import { getMarketThesisFor } from "../reasoning/market-thesis";
import { classifyNewsItemsLLM } from "../news-validator";
import type { AnalysisJob, JobResult } from "./types";
import { selectBestKey, getLiveKeysStats, getModelCapability } from "./state";
import { getJobTier } from "./queue";
import type { Scheduler } from "./scheduler";

export async function executeDecisionJob(
  job: AnalysisJob,
  scheduler: Scheduler,
): Promise<JobResult> {
  const startedAt = Date.now();
  const fallbackDecisionModel =
    process.env.GROQ_MODEL_DECISION?.trim() ||
    process.env.GROQ_MODEL?.trim() ||
    "llama-3.3-70b-versatile";

  // Abort check before we do any work
  if (job.abortSignal?.aborted) {
    return {
      ok: false,
      error: "Job aborted before pipeline start",
      source: "aborted",
      durationMs: Date.now() - startedAt,
    };
  }

  // Resolve purpose/model to select the best key
  let purpose: "decision" | "thesis" | "news" = "decision";
  if (job.kind === "thesis") purpose = "thesis";
  if (job.kind === "news") purpose = "news";
  const defaultModel =
    purpose === "decision"
      ? process.env.GROQ_MODEL_DECISION
      : purpose === "thesis"
      ? process.env.GROQ_MODEL_THESIS
      : process.env.GROQ_MODEL_NEWS;
      
  let model = job.modelOverride || defaultModel || process.env.GROQ_MODEL || fallbackDecisionModel;
  let modelCap = getModelCapability(model);
  let preferredAccountId: number | undefined;

  // 1. Strict JSON Enforcement
  if ((purpose === "decision" || purpose === "news" || purpose === "thesis") && !modelCap.supportsJson) {
    const jsonModel = process.env.GROQ_MODEL_DECISION || "qwen/qwen3-32b";
    console.warn(`[orch/pipeline] Model ${model} lacks JSON capability. Rerouting to ${jsonModel}`);
    model = jsonModel;
    modelCap = getModelCapability(model);
    job.modelOverride = model;
  }

  // 2. Execution Budget Awareness (Strict Hierarchy Enforcement)
  // Premium models must ONLY be used for ELITE_SETUP or EXECUTION_CRITICAL
  const isPremiumAllowed = job.priority === 0 || job.priority === 2; // EXECUTION_CRITICAL(0) or ELITE_SETUP(2)
  if (modelCap.tier === "premium" && !isPremiumAllowed) {
    const midModel = "qwen/qwen3-32b";
    console.warn(`[orch/pipeline] Budget Protection: Downgrading priority ${job.priority} job from premium ${model} to ${midModel}`);
    model = midModel;
    modelCap = getModelCapability(model);
    job.modelOverride = model;
  }

  // 3. Intelligent Tier Degradation & Fail-Fast Resolution
  // We try to find a healthy account for the requested model. If none exists, we degrade instantly.
  const fallbackChain = [model, "qwen/qwen3-32b", "llama-3.1-8b-instant", "meta-llama/llama-4-scout-17b-16e-instruct"];
  
  for (const candidate of fallbackChain) {
    // Re-verify json capability if degrading
    const cap = getModelCapability(candidate);
    if ((purpose === "decision" || purpose === "news" || purpose === "thesis") && !cap.supportsJson) {
      continue; // Skip models that can't fulfill the contract
    }

    preferredAccountId = selectBestKey(candidate);
    if (preferredAccountId !== undefined) {
      if (candidate !== model) {
        console.warn(`[orch/pipeline] Fail-Fast: ${model} exhausted/unavailable. Instantly degraded to ${candidate} (Account #${preferredAccountId})`);
        model = candidate;
        job.modelOverride = model;
      }
      break;
    }
  }

  // 4. Local-First Rescue Mode
  if (preferredAccountId === undefined) {
    console.warn(`[orch/pipeline] RESCUE MODE: ALL API keys and fallback models exhausted. Falling through to local engine for ${job.symbol}.`);
    return {
      ok: true,
      isTransient: false,
      skipRetry: true, // Don't churn the queue
      source: "local-fallback",
      durationMs: Date.now() - startedAt,
      ...(await runLocalFallback(job)),
    };
  }
  const isLastAttempt = job.attempt >= 4;

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
    const is429 =
      err?.status === 429 ||
      err?.message?.includes("rate limit") ||
      err?.message?.includes("429") ||
      err?.message?.includes("budget exhausted") ||
      err?.message?.includes("Token budget exhausted");

    if (is429 && !isLastAttempt) {
      // Re-check: if every model we could route to is cooled, do NOT
      // requeue. The scheduler honors skipRetry to stop the 5-attempt
      // storm that was previously congesting the queue and getting jobs
      // expired.
      const cheapModel =
        process.env.GROQ_MODEL_CHEAP?.trim() ||
        process.env.GROQ_MODEL_THESIS?.trim() ||
        process.env.GROQ_MODEL?.trim();
      const allCooled = [model, cheapModel].filter(Boolean).every((m) => {
        const s = getLiveKeysStats(m!);
        return s.length > 0 && s.every((k) => k.status === "cooldown" || k.status === "exhausted");
      });
      if (allCooled) {
        console.warn(
          `[orch/pipeline] 429 on ${job.symbol} and every fallback model is cooled — falling through to local engine (no retry).`,
        );
        return {
          ok: true,
          isTransient: false,
          skipRetry: true,
          source: "local-fallback",
          durationMs: Date.now() - startedAt,
          ...(await runLocalFallback(job)),
        };
      }
      console.warn(
        `[orch/pipeline] Job ${job.kind} ${job.symbol} rate limited (429) on attempt ${job.attempt}. Returning transient error.`,
      );
      return {
        ok: false,
        error: err.message || String(err),
        isTransient: true,
        durationMs: Date.now() - startedAt,
      };
    }

    const isUnavailable =
      err?.status === 404 ||
      err?.status === 400 ||
      err?.status === 503 ||
      err?.message?.toLowerCase().includes("model not found") ||
      err?.message?.toLowerCase().includes("model_not_found") ||
      err?.message?.toLowerCase().includes("not found") ||
      err?.message?.toLowerCase().includes("model unavailable") ||
      err?.message?.toLowerCase().includes("unknown model") ||
      err?.message?.toLowerCase().includes("unsupported model");

    if (isUnavailable && model !== fallbackDecisionModel && !isLastAttempt) {
      console.warn(
        `[orch/pipeline] Job ${job.kind} ${job.symbol} failed with model unavailable/unsupported error on model ${model}. Overriding model to ${fallbackDecisionModel} and returning transient error.`,
      );
      job.modelOverride = fallbackDecisionModel;
      return {
        ok: false,
        error: `Model unavailable: ${err.message || String(err)}`,
        isTransient: true,
        durationMs: Date.now() - startedAt,
      };
    }

    // Proceed to fallback on non-429 error, or if it is the last attempt of a 429
    console.warn(
      `[orch/pipeline] Job ${job.kind} ${job.symbol} failed (attempt ${job.attempt}, isLast=${isLastAttempt}). Error: ${
        err.message || String(err)
      }. Invoking fallback execution.`,
    );
  }

  // Fallback engine path (fallbackAllowed = true, accountId = undefined)
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
    error: `Job execution failed permanently.`,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Run the deterministic local engine for a job. Used as a fast-fail when
 * every configured model is cooled — avoids the retry storm by giving the
 * caller a definitive answer immediately. Returns the partial JobResult
 * fields the caller can spread into the final result.
 */
async function runLocalFallback(job: AnalysisJob): Promise<Partial<JobResult>> {
  try {
    if (job.kind === "decision") {
      const fallback = await getMarketDecisionFor(job.payload, undefined, true);
      return {
        decision: fallback || undefined,
        source: fallback?.source || "local-fallback",
      };
    }
    if (job.kind === "thesis") {
      const fallback = await getMarketThesisFor(job.payload, undefined, true);
      return { thesis: fallback || undefined, source: fallback ? "llm" : undefined };
    }
    const fallback = await classifyNewsItemsLLM(
      job.symbol,
      job.coinName,
      job.items,
      undefined,
      true,
    );
    return { verdicts: fallback || [], source: fallback ? "llm" : "prefilter" };
  } catch (err) {
    return { ok: false, error: `Local fallback crashed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
