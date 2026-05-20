import { NO_TRADE_DECISIONS } from "@/services/ai/schemas";

import type { RejectionReason, Validator } from "./types";

/**
 * Validators are evaluated in order. The first failure stops the assessment
 * (the engine collects every failure, but the caller can short-circuit if
 * they only care about pass/fail).
 *
 * Ordering rationale: cheap structural checks first, then risk-envelope, then
 * regime/quality filters. This keeps the rejection log readable — if the
 * trade fails at "no_directional_side" we never bother showing "min_rr 1.6".
 */

const fail = (
  code: string,
  message: string,
  detail?: Record<string, unknown>,
): RejectionReason => ({ code, message, detail });

export const STRUCTURAL_VALIDATORS: Validator[] = [
  {
    id: "execute_false",
    name: "LLM declined to execute",
    evaluate: (p) =>
      p.decision.executeTrade
        ? null
        : fail("execute_false", `LLM emitted executeTrade=false (${p.decision.decision})`),
  },
  {
    id: "no_trade_decision",
    name: "Non-directional decision",
    evaluate: (p) =>
      NO_TRADE_DECISIONS.has(p.decision.decision)
        ? fail("no_trade_decision", `Decision is ${p.decision.decision}`)
        : null,
  },
  {
    id: "zero_stop_distance",
    name: "Stop loss equals entry",
    evaluate: (p) =>
      Math.abs(p.decision.entryPrice - p.decision.stopLoss) <= 1e-9
        ? fail("zero_stop_distance", "Stop loss is identical to entry")
        : null,
  },
  {
    id: "tp_sl_side",
    name: "TP/SL on wrong side of entry",
    evaluate: (p) => {
      const { entryPrice, takeProfit, stopLoss } = p.decision;
      if (p.side === "LONG" && (stopLoss >= entryPrice || takeProfit <= entryPrice)) {
        return fail("tp_sl_side", "LONG: SL must be below entry and TP above");
      }
      if (p.side === "SHORT" && (stopLoss <= entryPrice || takeProfit >= entryPrice)) {
        return fail("tp_sl_side", "SHORT: SL must be above entry and TP below");
      }
      return null;
    },
  },
];

export const QUALITY_VALIDATORS: Validator[] = [
  {
    id: "min_expected_profit",
    name: "Expected profit too small",
    evaluate: (_p, d, t) =>
      d.expectedProfitPercent < t.minExpectedProfitPercent
        ? fail(
            "min_expected_profit",
            `Expected profit ${d.expectedProfitPercent.toFixed(2)}% < ${t.minExpectedProfitPercent}%`,
            { expectedProfitPercent: d.expectedProfitPercent, threshold: t.minExpectedProfitPercent },
          )
        : null,
  },
  {
    id: "min_rr",
    name: "Risk/reward below floor",
    evaluate: (_p, d, t) =>
      d.riskRewardRatio < t.minRiskRewardRatio
        ? fail("min_rr", `RR ${d.riskRewardRatio.toFixed(2)} < ${t.minRiskRewardRatio}`, {
            riskRewardRatio: d.riskRewardRatio,
            threshold: t.minRiskRewardRatio,
          })
        : null,
  },
  {
    id: "min_confidence",
    name: "LLM confidence below floor",
    evaluate: (p, _d, t) =>
      p.decision.confidence < t.minConfidence
        ? fail(
            "min_confidence",
            `Confidence ${p.decision.confidence} < ${t.minConfidence}`,
            { confidence: p.decision.confidence, threshold: t.minConfidence },
          )
        : null,
  },
  {
    id: "setup_quality_floor",
    name: "Setup graded too low",
    evaluate: (p) => {
      const sq = p.decision.setupQuality;
      if (sq === "Avoid") return fail("setup_quality_floor", "LLM graded setup as Avoid");
      return null;
    },
  },
  {
    id: "regime_high_vol",
    name: "Regime blocks entries",
    evaluate: (p) => {
      // Allow B/B+/A/A+ in High Vol; only block C and Avoid.
      if (p.marketRegime !== "High Volatility") return null;
      const sq = p.decision.setupQuality;
      if (sq === "C") {
        return fail(
          "regime_high_vol",
          "High-volatility regime requires B grade or better",
        );
      }
      return null;
    },
  },
  {
    id: "volatility_cap",
    name: "Volatility above ceiling",
    evaluate: (p, _d, t) =>
      p.atrPct != null && p.atrPct > t.maxVolatilityThreshold
        ? fail(
            "volatility_cap",
            `ATR ${p.atrPct.toFixed(2)}% > ${t.maxVolatilityThreshold}% — too unstable`,
            { atrPct: p.atrPct, threshold: t.maxVolatilityThreshold },
          )
        : null,
  },
  {
    id: "strategy_conflict",
    name: "Conflicting strategies dominate",
    evaluate: (p) => {
      const aligned = p.decision.alignedStrategies?.length ?? 0;
      const conflicting = p.decision.conflictingStrategies?.length ?? 0;
      // Only block if we have data AND conflicts outnumber alignments.
      if (aligned + conflicting === 0) return null;
      return conflicting > aligned
        ? fail(
            "strategy_conflict",
            `${conflicting} conflicting strategies vs ${aligned} aligned`,
            { aligned, conflicting },
          )
        : null;
    },
  },
];

export const BOOK_VALIDATORS: Validator[] = [
  {
    id: "book_full",
    name: "Position book at capacity",
    evaluate: (p, _d, t) =>
      p.book.openPositionsCount >= t.maxOpenPositions
        ? fail(
            "book_full",
            `Book full (${p.book.openPositionsCount}/${t.maxOpenPositions})`,
            { openPositionsCount: p.book.openPositionsCount, max: t.maxOpenPositions },
          )
        : null,
  },
  {
    id: "duplicate_side",
    name: "Duplicate side on symbol",
    evaluate: (p) =>
      p.book.hasDuplicateSide
        ? fail("duplicate_side", `Existing ${p.side} on ${p.symbol}`)
        : null,
  },
  {
    id: "entry_cooldown",
    name: "Per-symbol cooldown active",
    evaluate: (p, _d, t) => {
      const since = p.book.msSinceLastExecution;
      if (since == null) return null;
      if (since >= t.perSymbolEntryCooldownMs) return null;
      const wait = Math.ceil((t.perSymbolEntryCooldownMs - since) / 1000);
      return fail("entry_cooldown", `Cooldown ${wait}s`, { waitSeconds: wait });
    },
  },
  {
    id: "entry_drift",
    name: "LLM entry stale vs live mark",
    evaluate: (p, d, t) =>
      d.entryDriftBps > t.maxEntryDriftBps
        ? fail(
            "entry_drift",
            `Entry drift ${(d.entryDriftBps / 100).toFixed(2)}% > ${(t.maxEntryDriftBps / 100).toFixed(2)}%`,
            { entryDriftBps: d.entryDriftBps },
          )
        : null,
  },
  {
    id: "insufficient_balance",
    name: "Available balance too low",
    evaluate: (p, _d, t) =>
      p.book.availableBalance < t.minAvailableBalance
        ? fail(
            "insufficient_balance",
            `Available ${p.book.availableBalance.toFixed(2)} < ${t.minAvailableBalance}`,
          )
        : null,
  },
];

/** Full pipeline in evaluation order. */
export const VALIDATORS: Validator[] = [
  ...STRUCTURAL_VALIDATORS,
  ...QUALITY_VALIDATORS,
  ...BOOK_VALIDATORS,
];
