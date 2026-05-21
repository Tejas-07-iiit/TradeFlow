import { getMarketDecisionFor } from "../reasoning/market-decision";
import { getMarketThesisFor } from "../reasoning/market-thesis";
import { classifyNewsItemsLLM } from "../news-validator";
import type { AnalysisJob, JobResult } from "./types";
import { selectBestKey, getLiveKeysStats } from "./state";
import type { Scheduler } from "./scheduler";

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
  let model = defaultModel || process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

  // Model Routing & Downgrading Logic
  if (job.modelOverride) {
    model = job.modelOverride;
  } else {
    let modelSwitched = false;
    const queueDepth = scheduler.stats({ inFlightKeys: [] }).queued;
    
    // Stress-downgrade decision models from heavy reasoning models (DeepSeek/Qwen) to faster ones under load
    if (purpose === "decision" && queueDepth > 3) {
      if (model.toLowerCase().includes("deepseek") || model.toLowerCase().includes("qwen")) {
        console.warn(
          `[orch/pipeline] Queue depth (${queueDepth}) > 3, stress-downgrading decision model from ${model} to llama-3.3-70b-versatile`,
        );
        model = "llama-3.3-70b-versatile";
        modelSwitched = true;
      }
    }

    // Downgrade/switch model if the primary model is fully in cooldown across all keys
    const stats = getLiveKeysStats(model);
    const allInCooldown = stats.length > 0 && stats.every(s => s.status === "cooldown" || s.status === "exhausted");
    if (allInCooldown) {
      const fallbackModel = "llama-3.3-70b-versatile";
      if (model !== fallbackModel) {
        console.warn(
          `[orch/pipeline] Primary model ${model} is fully in cooldown. Dynamically routing job to alternative model: ${fallbackModel}`,
        );
        model = fallbackModel;
        modelSwitched = true;
      }
    }

    if (modelSwitched) {
      job.modelOverride = model;
    }
  }

  const preferredAccountId = selectBestKey(model);
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
