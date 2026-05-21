/**
 * AI Orchestrator — public API.
 *
 * Singleton scheduler that owns the entire LLM concurrency budget for
 * this server process. Every code path that wants an LLM-backed
 * decision, thesis, or news validation should funnel through this module.
 */

import { findInFlight, inFlightKeys, trackInFlight } from "./dedup";
import { executeDecisionJob } from "./pipeline";
import { computeDecisionPriority } from "./priority";
import { Scheduler } from "./scheduler";
import {
  PRIORITY_LABELS,
  PRIORITY_SLA_MS,
  JobPriority,
  type DecisionJob,
  type ThesisJob,
  type NewsJob,
  type JobResult,
  type OrchestratorStats,
  type LlmClassifierItem,
} from "./types";
import type { DecisionInput, ThesisInput } from "../schemas";

const scheduler = new Scheduler(executeDecisionJob);

/**
 * Compose the dedup key. Two requests collide if they have the same
 * symbol+timeframe+regime+coarse-price bucket.
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
      `[orch] ${PRIORITY_LABELS[priority]} ${input.symbol} DECISION → ${tag} in ${result.durationMs}ms (queued ${scheduler.stats({ inFlightKeys: [] }).queued} active ${scheduler.stats({ inFlightKeys: [] }).active})`,
    );
    return result;
  });

  return trackInFlight(dedupKey, promise);
}

/**
 * Submit a thesis request through the orchestrator.
 */
export function submitThesisJob(
  input: ThesisInput,
  options: SubmitOptions = {},
): Promise<JobResult> {
  const dedupKey = `thesis:${input.symbol}:${input.timeframe}:${input.marketRegime}:${input.ruleSignal}`;
  const existing = findInFlight(dedupKey);
  if (existing) return existing;

  const priority = JobPriority.ROUTINE_SCAN;
  const now = Date.now();

  const job: ThesisJob = {
    kind: "thesis",
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
    console.info(
      `[orch] THESIS ${input.symbol} → ${result.ok ? "LLM" : "FAILED"} in ${result.durationMs}ms (queued ${scheduler.stats({ inFlightKeys: [] }).queued} active ${scheduler.stats({ inFlightKeys: [] }).active})`,
    );
    return result;
  });

  return trackInFlight(dedupKey, promise);
}

/**
 * Submit a news validation request through the orchestrator.
 */
export function submitNewsJob(
  symbol: string,
  coinName: string,
  items: LlmClassifierItem[],
  options: SubmitOptions = {},
): Promise<JobResult> {
  const itemIds = items.map((it) => it.id).join(",");
  const dedupKey = `news:${symbol}:${itemIds}`;
  const existing = findInFlight(dedupKey);
  if (existing) return existing;

  const priority = JobPriority.POSITION_MGMT;
  const now = Date.now();

  const job: NewsJob = {
    kind: "news",
    symbol,
    coinName,
    items,
    dedupKey,
    priority,
    enqueuedAt: now,
    expiresAt: now + PRIORITY_SLA_MS[priority],
    abortSignal: options.signal,
  };

  const promise = scheduler.submit(job).then((result) => {
    console.info(
      `[orch] NEWS ${symbol} → ${result.ok ? "LLM" : "FAILED"} in ${result.durationMs}ms (queued ${scheduler.stats({ inFlightKeys: [] }).queued} active ${scheduler.stats({ inFlightKeys: [] }).active})`,
    );
    return result;
  });

  return trackInFlight(dedupKey, promise);
}

/**
 * Snapshot of scheduler + dedup state.
 */
export function getOrchestratorStats(model?: string): OrchestratorStats {
  return scheduler.stats({ inFlightKeys: inFlightKeys(), model });
}

export { JobPriority } from "./types";
export type { JobResult, OrchestratorStats };
export type { SubmitOptions };

