/**
 * AI Orchestrator — public API.
 *
 * Singleton scheduler that owns the entire LLM concurrency budget for
 * this server process. Every code path that wants an LLM-backed
 * `MarketDecision` should funnel through `submitDecisionJob` rather than
 * calling `getMarketDecisionFor` directly, so the scheduler can prioritise
 * and rate-limit globally.
 *
 * Module-scoped singleton. In a Next.js server process the module evaluates
 * once and the scheduler instance survives across request handlers, which
 * is exactly what we want — server actions all see the same queue.
 *
 * Lifetime: tied to the process. There is intentionally no "shutdown"
 * call because a graceful drain on SIGTERM hasn't been needed for paper
 * trading; we can layer that in later if it becomes important for
 * production AWS deployment.
 */

import { findInFlight, inFlightKeys, trackInFlight } from "./dedup";
import { executeDecisionJob } from "./pipeline";
import { computeDecisionPriority } from "./priority";
import { Scheduler } from "./scheduler";
import {
  PRIORITY_LABELS,
  PRIORITY_SLA_MS,
  type DecisionJob,
  type JobResult,
  type OrchestratorStats,
} from "./types";
import type { DecisionInput } from "../schemas";

const scheduler = new Scheduler(executeDecisionJob);

/**
 * Compose the dedup key. Two requests collide if they have the same
 * symbol+timeframe+regime+coarse-price bucket. We deliberately do NOT
 * include the full snapshot in the key — the inner cache in
 * `market-decision.ts` already has a fingerprint that's tighter; this
 * key is for collapsing concurrent submitters in the orchestrator
 * window.
 */
function buildDedupKey(input: DecisionInput): string {
  const priceBucket = Math.round(input.price * 100) / 100;
  const align = input.strategySnapshot?.alignmentScore ?? "n/a";
  return `decision:${input.symbol}:${input.timeframe}:${input.marketRegime}:${priceBucket}:${align}`;
}

interface SubmitOptions {
  /** Caller-side cancellation. Pipeline checks between stages. */
  signal?: AbortSignal;
}

/**
 * Submit a decision request through the orchestrator.
 *
 * Always returns a `JobResult` (resolved promise, never rejects on
 * normal-path failures). The pipeline's local fallback engine guarantees
 * we get a decision even when every LLM provider is down.
 *
 * Concurrent submitters of the same dedup key share one execution.
 */
export function submitDecisionJob(
  input: DecisionInput,
  options: SubmitOptions = {},
): Promise<JobResult> {
  const dedupKey = buildDedupKey(input);
  const existing = findInFlight(dedupKey);
  if (existing) return existing;

  const priority = computeDecisionPriority(input);
  const now = Date.now();

  const job: DecisionJob = {
    kind: "decision",
    symbol: input.symbol,
    timeframe: input.timeframe,
    payload: input,
    dedupKey,
    priority,
    enqueuedAt: now,
    expiresAt: now + PRIORITY_SLA_MS[priority],
    abortSignal: options.signal,
  };

  const promise = scheduler.submit(job).then((result) => {
    // Lightweight telemetry. Keeping this in the orchestrator (not the
    // pipeline) so we always log dispatch outcome regardless of source.
    const tag =
      result.source === "local-fallback"
        ? "FALLBACK"
        : result.source === "prefilter"
          ? "PREFILTER"
          : result.source === "expired"
            ? "EXPIRED"
            : result.source === "aborted"
              ? "ABORTED"
              : "LLM";
    console.info(
      `[orch] ${PRIORITY_LABELS[priority]} ${input.symbol} → ${tag} in ${result.durationMs}ms (queued ${scheduler.stats({ inFlightKeys: [] }).queued} active ${scheduler.stats({ inFlightKeys: [] }).active})`,
    );
    return result;
  });

  return trackInFlight(dedupKey, promise);
}

/**
 * Snapshot of scheduler + dedup state. Exposed for observability surfaces
 * (dev console, future ops dashboard).
 */
export function getOrchestratorStats(): OrchestratorStats {
  return scheduler.stats({ inFlightKeys: inFlightKeys() });
}

export { JobPriority } from "./types";
export type { JobResult, OrchestratorStats };
export type { SubmitOptions };
