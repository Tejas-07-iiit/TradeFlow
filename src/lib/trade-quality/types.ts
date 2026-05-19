/**
 * Types for the trade-quality assessment pipeline.
 *
 * The pipeline is split into three pure layers:
 *
 *   TradeProposal           — everything we know about an LLM-proposed trade
 *        │                    plus live market context.
 *        ▼
 *   Validator[] (pass/fail) — each rule is one Validator. They're pure
 *        │                    functions over (proposal, ctx, derived).
 *        ▼
 *   QualityScore + Grade    — independent of validation; even a *rejected*
 *        │                    trade gets a score so we can audit close calls.
 *        ▼
 *   TradeAssessment         — `approved` if no hard validator failed, plus
 *                              all metrics, warnings, and rejection reasons.
 *
 * Nothing in this module touches stores, the network, or React — it's all
 * pure math and predicates, which is what makes it independently testable.
 */

import type {
  MarketDecision,
  SetupQuality,
} from "@/services/ai/schemas";

/** Letter grade attached to every trade — for executed and rejected alike. */
export type Grade = "A+" | "A" | "B" | "C" | "D";

/**
 * The active book the assessor needs to know about. Kept minimal — we only
 * need the structural facts (counts, dupe-side, cooldowns), not the full
 * position rows.
 */
export interface BookContext {
  /** Currently open or partially-open positions, irrespective of side. */
  openPositionsCount: number;
  /** True if there's already an open position on this side of this symbol. */
  hasDuplicateSide: boolean;
  /** ms since the last LLM execution on this symbol, or `null` if never. */
  msSinceLastExecution: number | null;
  /** Wallet balance currently free for new positions. */
  availableBalance: number;
}

/**
 * Snapshot of what the assessor receives. Most fields originate from the LLM
 * (`decision`), but live context (`livePrice`, `book`, `atrPct`, `regime`)
 * is folded in by the engine so validators don't have to talk to stores.
 */
export interface TradeProposal {
  symbol: string;
  side: "LONG" | "SHORT";
  decision: MarketDecision;
  /** Latest websocket tick at the moment of evaluation. */
  livePrice: number;
  /** ATR percent from indicators (null if not yet computed). */
  atrPct: number | null;
  /** Regime classifier output (e.g. "Trending", "Choppy"). */
  marketRegime: string;
  book: BookContext;
}

/**
 * Derived metrics computed once per assessment from the proposal. Centralised
 * here so validators don't each recompute (and possibly disagree on) the same
 * numbers.
 */
export interface DerivedMetrics {
  expectedProfitPercent: number;
  expectedLossPercent: number;
  riskRewardRatio: number;
  /** Distance between live tick and the LLM's quoted entry (basis points). */
  entryDriftBps: number;
  /** Normalised volatility score: clamp(atrPct, 0, 10) * 10 → 0-100. */
  volatilityScore: number;
}

/** Structured rejection — easier to filter/group in analytics than a string. */
export interface RejectionReason {
  /** Stable machine-readable code, e.g. "min_rr", "low_confidence". */
  code: string;
  message: string;
  detail?: Record<string, unknown>;
}

/** Soft flag — degrades the grade but doesn't block execution. */
export interface QualityWarning {
  code: string;
  message: string;
}

export interface QualityScore {
  /** 0-100 composite score. */
  value: number;
  grade: Grade;
  /** Per-factor breakdown for the audit log. */
  factors: Array<{ name: string; weight: number; score: number }>;
}

export interface TradeAssessment {
  approved: boolean;
  rejections: RejectionReason[];
  warnings: QualityWarning[];
  metrics: DerivedMetrics;
  score: QualityScore;
  /** LLM-emitted grade kept alongside our own for comparison. */
  llmSetupQuality: SetupQuality;
}

/**
 * The threshold bundle a validator sees. Engines may construct one from
 * defaults + regime overrides via `resolveThresholds()`.
 */
export interface Thresholds {
  minExpectedProfitPercent: number;
  minRiskRewardRatio: number;
  preferredRiskRewardRatio: number;
  minConfidence: number;
  maxRiskPerTradePercent: number;
  /** Reject when ATR% exceeds this (volatility too extreme). */
  maxVolatilityThreshold: number;
  /** Hard cap on simultaneous open positions. */
  maxOpenPositions: number;
  /** Block entries that fire <N ms after the last fill for the same symbol. */
  perSymbolEntryCooldownMs: number;
  /** Reject when |live - proposed entry| / live > this (LLM is stale). */
  maxEntryDriftBps: number;
  /** Reject when available balance is below this. */
  minAvailableBalance: number;
}

/**
 * A single validator. Pure: same inputs → same output, no side effects.
 *
 * Returns `null` on pass, or a `RejectionReason` to block the trade.
 * The validator name lives next to its logic so audit logs are self-describing.
 */
export interface Validator {
  /** Stable machine code matching `RejectionReason.code`. */
  id: string;
  name: string;
  evaluate(
    proposal: TradeProposal,
    derived: DerivedMetrics,
    thresholds: Thresholds,
  ): RejectionReason | null;
}
