/**
 * Orchestrator types — the contract between event producers (subscribers,
 * server actions, event sources) and the scheduler / pipeline.
 *
 * Design intent: keep this layer free of provider-specific or LLM-specific
 * concerns. The orchestrator schedules generic `AnalysisJob`s; the pipeline
 * step decides what each kind of job actually means.
 */

import type { CachedDecision } from "../reasoning/market-decision";
import type { DecisionInput } from "../schemas";

/**
 * Priority levels, lowest number wins. Inside a bucket, jobs are FIFO.
 *
 *   EXECUTION_CRITICAL  — open position needs immediate decision (regime
 *                         flipped against the held side, stop-loss within
 *                         a fraction of ATR, etc.). Never delayed by other
 *                         priorities.
 *   POSITION_MGMT       — open position routine re-evaluation (cooldown'd
 *                         per symbol so we don't spam).
 *   ELITE_SETUP         — snapshot alignment ≥ 80; looks like an A/A+
 *                         candidate worth the premium-tier reasoning.
 *   NEW_SETUP           — snapshot alignment 50-79; tradeable but cheap-tier.
 *   ROUTINE_SCAN        — periodic watchlist sweep, no specific edge.
 *   RECHECK             — refresh a stale decision; lowest priority because
 *                         the cached value is still valid.
 */
export enum JobPriority {
  EXECUTION_CRITICAL = 0,
  POSITION_MGMT = 1,
  ELITE_SETUP = 2,
  NEW_SETUP = 3,
  ROUTINE_SCAN = 4,
  RECHECK = 5,
}

export const PRIORITY_LABELS: Record<JobPriority, string> = {
  [JobPriority.EXECUTION_CRITICAL]: "EXEC_CRITICAL",
  [JobPriority.POSITION_MGMT]: "POSITION_MGMT",
  [JobPriority.ELITE_SETUP]: "ELITE_SETUP",
  [JobPriority.NEW_SETUP]: "NEW_SETUP",
  [JobPriority.ROUTINE_SCAN]: "ROUTINE_SCAN",
  [JobPriority.RECHECK]: "RECHECK",
};

export type JobKind = "decision" | "thesis";

/**
 * Per-priority SLA in ms. If a job hasn't been dispatched within this
 * window, it's dropped from the queue. Prevents stale work from running
 * when conditions have moved on. Lower-priority jobs expire faster — if
 * a routine scan is waiting more than 15s, the next round-robin tick will
 * generate a fresher one anyway.
 */
export const PRIORITY_SLA_MS: Record<JobPriority, number> = {
  [JobPriority.EXECUTION_CRITICAL]: 30_000,
  [JobPriority.POSITION_MGMT]: 20_000,
  [JobPriority.ELITE_SETUP]: 25_000,
  [JobPriority.NEW_SETUP]: 20_000,
  [JobPriority.ROUTINE_SCAN]: 15_000,
  [JobPriority.RECHECK]: 10_000,
};

/**
 * A decision-kind job. `payload` is the already-validated `DecisionInput`
 * the pipeline will execute against. `dedupKey` collapses concurrent
 * submitters of the same logical work — the pipeline owns one in-flight
 * promise per key and all callers await it.
 */
export interface DecisionJob {
  kind: "decision";
  symbol: string;
  timeframe: string;
  payload: DecisionInput;
  dedupKey: string;
  priority: JobPriority;
  enqueuedAt: number;
  /** Wall-clock deadline after which the queue will drop this job. */
  expiresAt: number;
  /** Caller cancellation. Pipeline checks between stages. */
  abortSignal?: AbortSignal;
}

/** Future-proofing — thesis/news jobs slot in alongside decision jobs. */
export type AnalysisJob = DecisionJob;

/**
 * Result type emitted by the pipeline. The orchestrator forwards this
 * verbatim to the original submitter via the promise it returned.
 */
export interface JobResult {
  ok: boolean;
  /** Present when `ok` is true. */
  decision?: CachedDecision;
  /** Present when `ok` is false. */
  error?: string;
  /** Pipeline-level source — same vocabulary as `CachedDecision.source`. */
  source?: "llm" | "prefilter" | "local-fallback" | "cache" | "expired" | "aborted";
  /** Total wallclock time from submit to settle. */
  durationMs: number;
}

/**
 * Lightweight stats for observability + ops dashboards.
 */
export interface OrchestratorStats {
  queued: number;
  active: number;
  byPriority: Record<string, number>;
  inFlightKeys: string[];
  totalDispatched: number;
  totalExpired: number;
  totalAborted: number;
}
