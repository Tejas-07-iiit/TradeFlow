"use client";

import { create } from "zustand";

import type { MarketDecision } from "@/services/ai/schemas";
import type { Grade } from "@/lib/trade-quality/types";
import type { NewsValidationResult } from "@/services/news/validator-types";

export interface DecisionEntry {
  decision: MarketDecision;
  generatedAt: string;
  provider: string;
  model: string;
  /** Cache key from the reasoning layer, useful for change detection. */
  key: string;
  /**
   * News-aware risk validation result for this candidate. May be undefined
   * on the legacy market-decision path; always populated by the strategy
   * decision flow. `status === "unavailable"` is the fail-open marker —
   * the engine treats it as "no adjustment, no rejection".
   */
  newsValidation?: NewsValidationResult;
}

/**
 * Per-failure diagnostic captured on a rejection. Mirrors
 * `RejectionReason` from `@/lib/trade-quality/types` but kept structurally
 * permissive so the store doesn't import server-only types.
 */
export interface RejectionDetail {
  code: string;
  message: string;
}

/**
 * Quality snapshot attached to every execution attempt — executed AND
 * rejected. Lets the UI render "this trade barely missed" or "this trade
 * was an A+ with 3x RR" without re-running the assessor.
 */
export interface ExecutionQuality {
  qualityScore: number;
  grade: Grade;
  expectedProfitPercent: number;
  expectedLossPercent: number;
  riskRewardRatio: number;
  volatilityScore: number;
  marketRegime: string;
}

/**
 * One row per LLM-driven execution attempt. Kept on the store (not just the
 * DB) so the UI can render the in-flight reasoning trail without waiting for
 * an RSC revalidation round-trip.
 */
export interface ExecutionLogEntry {
  id: string;
  symbol: string;
  /** ms timestamp. */
  at: number;
  decision: MarketDecision["decision"];
  setupQuality: MarketDecision["setupQuality"];
  confidence: number;
  /** "executed" — order created. "rejected" — risk gate blocked it. */
  outcome: "executed" | "rejected";
  /** Primary rejection reason (first failure), kept for backwards compat. */
  rejectionReason?: string;
  /** Full structured rejection list when outcome=rejected. */
  rejections?: RejectionDetail[];
  /** Order id on success. */
  orderId?: string;
  /** First reasoning line — keeps the log row scannable. */
  headline: string;
  /** Trade-quality snapshot (executed or rejected — always populated). */
  quality?: ExecutionQuality;
  /**
   * News validation snapshot for this attempt. Lets the UI render
   * "size reduced due to bearish regulation news" or "rejected — exchange halt"
   * without re-fetching anything.
   */
  newsValidation?: NewsValidationResult;
}

interface AiDecisionState {
  /** symbol → most recent decision we've fetched */
  bySymbol: Record<string, DecisionEntry | undefined>;
  loading: Record<string, boolean | undefined>;
  error: Record<string, string | undefined>;
  /** Last LLM-fired entry time per symbol (ms). Used by the executor cooldown. */
  lastExecutedAt: Record<string, number | undefined>;
  /** Per-symbol latest exit attempt time (ms). Used by exit watcher cooldown. */
  lastExitAt: Record<string, number | undefined>;
  /** Most recent 50 execution attempts across all symbols. */
  executionLog: ExecutionLogEntry[];

  setDecision: (symbol: string, entry: DecisionEntry) => void;
  setLoading: (symbol: string, loading: boolean) => void;
  setError: (symbol: string, error: string | undefined) => void;
  markExecuted: (symbol: string) => void;
  markExited: (symbol: string) => void;
  appendLog: (entry: ExecutionLogEntry) => void;
  clearLog: () => void;
}

export const useAiDecisionStore = create<AiDecisionState>((set) => ({
  bySymbol: {},
  loading: {},
  error: {},
  lastExecutedAt: {},
  lastExitAt: {},
  executionLog: [],

  setDecision: (symbol, entry) =>
    set((s) => ({
      bySymbol: { ...s.bySymbol, [symbol]: entry },
      error: { ...s.error, [symbol]: undefined },
    })),
  setLoading: (symbol, loading) =>
    set((s) => ({ loading: { ...s.loading, [symbol]: loading } })),
  setError: (symbol, error) =>
    set((s) => ({ error: { ...s.error, [symbol]: error } })),
  markExecuted: (symbol) =>
    set((s) => ({ lastExecutedAt: { ...s.lastExecutedAt, [symbol]: Date.now() } })),
  markExited: (symbol) =>
    set((s) => ({ lastExitAt: { ...s.lastExitAt, [symbol]: Date.now() } })),
  appendLog: (entry) =>
    set((s) => ({ executionLog: [entry, ...s.executionLog].slice(0, 50) })),
  clearLog: () => set({ executionLog: [] }),
}));
