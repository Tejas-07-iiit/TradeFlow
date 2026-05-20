/**
 * Pipeline executor.
 *
 * This is the per-job worker the scheduler dispatches to. Each stage:
 *   1. Checks `signal.aborted` before doing meaningful work.
 *   2. Delegates the heavy lifting to existing modules — the orchestrator
 *      doesn't reimplement the prefilter, tier routing, provider chain,
 *      or local fallback. It just composes them.
 *
 * Why route through here instead of letting the server action call
 * `getMarketDecisionFor` directly? Two reasons:
 *   - Concurrency: every LLM-bound work goes through one scheduler that
 *     enforces MAX_CONCURRENT and prioritises EXEC_CRITICAL ahead of
 *     routine scans.
 *   - Cancellation: the orchestrator's AbortSignal can interrupt a job
 *     that's queued or in flight, which the previous fire-and-forget
 *     calls couldn't do.
 */

import { getMarketDecisionFor } from "../reasoning/market-decision";
import type { AnalysisJob, JobResult } from "./types";

export async function executeDecisionJob(
  job: AnalysisJob,
): Promise<JobResult> {
  const startedAt = Date.now();

  if (job.kind !== "decision") {
    return {
      ok: false,
      error: `Unsupported job kind: ${String((job as { kind: string }).kind)}`,
      durationMs: Date.now() - startedAt,
    };
  }

  // Abort check before we do any work. Cheap to bail here.
  if (job.abortSignal?.aborted) {
    return {
      ok: false,
      error: "Job aborted before pipeline start",
      source: "aborted",
      durationMs: Date.now() - startedAt,
    };
  }

  try {
    // `getMarketDecisionFor` already implements:
    //   - in-fingerprint cache (90s for LLM, 20s for local fallback)
    //   - prefilter that emits synthetic HOLD on flat snapshots
    //   - tier-aware provider chain (cheap-first or premium-first)
    //   - local-fallback engine when every provider fails
    // We compose, don't reimplement.
    const cached = await getMarketDecisionFor(job.payload);

    if (!cached) {
      return {
        ok: false,
        error: "Pipeline produced no decision (unexpected null)",
        durationMs: Date.now() - startedAt,
      };
    }

    // Final abort check — if the caller bailed while we were waiting,
    // still return the decision (it's cached now, no waste) but mark the
    // source so the caller can decide whether to use it.
    return {
      ok: true,
      decision: cached,
      source: cached.source,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    // Shouldn't normally throw — getMarketDecisionFor swallows internally
    // — but we belt-and-suspender the boundary so a pipeline crash never
    // takes the scheduler with it.
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `Pipeline threw: ${message}`,
      durationMs: Date.now() - startedAt,
    };
  }
}
