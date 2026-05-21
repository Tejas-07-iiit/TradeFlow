import { scoreTrade } from "./score";
import { resolveThresholds, DEFAULT_THRESHOLDS } from "./thresholds";
import type {
  DerivedMetrics,
  QualityWarning,
  TradeAssessment,
  TradeProposal,
  Thresholds,
} from "./types";
import { VALIDATORS } from "./validators";

export * from "./types";
export { DEFAULT_THRESHOLDS, REGIME_OVERRIDES, resolveThresholds } from "./thresholds";
export { VALIDATORS } from "./validators";

/**
 * Compute the derived metrics every validator references. Centralised so that
 * "expected profit" means the same thing everywhere.
 *
 * Sign convention: all *percent* fields are returned as positive numbers —
 * direction is implicit in `proposal.side`.
 */
export function deriveMetrics(proposal: TradeProposal): DerivedMetrics {
  const { entryPrice, takeProfit, stopLoss } = proposal.decision;
  const expectedProfitPercent =
    (Math.abs(takeProfit - entryPrice) / entryPrice) * 100;
  const expectedLossPercent =
    (Math.abs(entryPrice - stopLoss) / entryPrice) * 100;
  const riskRewardRatio =
    expectedLossPercent > 0 ? expectedProfitPercent / expectedLossPercent : 0;

  // 1. Validate numeric inputs defensively
  const expectedEntry = Number(entryPrice);
  const currentPrice = Number(proposal.livePrice);

  let entryDriftBps = 0;

  if (
    !Number.isFinite(expectedEntry) ||
    expectedEntry <= 0 ||
    !Number.isFinite(currentPrice) ||
    currentPrice <= 0
  ) {
    console.error(
      `[DRIFT-CALCULATION-ERROR] Invalid inputs for drift calculation. ` +
      `Symbol: ${proposal.symbol}, ` +
      `expectedEntry: ${proposal.decision.entryPrice} (parsed: ${expectedEntry}), ` +
      `currentPrice: ${proposal.livePrice} (parsed: ${currentPrice})`
    );
    // Safe fallback value that triggers rejection (cap drift at 100% / 10,000 basis points)
    entryDriftBps = 10_000;
  } else {
    // Verify expectedEntry and currentPrice are same symbol using key if present
    let symbolMismatch = false;
    if (proposal.key) {
      const keySymbol = proposal.key.split("|")[0];
      if (keySymbol && keySymbol.toUpperCase() !== proposal.symbol.toUpperCase()) {
        console.error(
          `[DRIFT-PROTECTION-ALERT] Symbol mismatch! ` +
          `Proposal symbol: ${proposal.symbol}, Key symbol: ${keySymbol}. ` +
          `Expected Entry: ${expectedEntry.toFixed(4)}, Current Price: ${currentPrice.toFixed(4)}`
        );
        symbolMismatch = true;
      }
    }

    // Magnitude check: if prices differ by more than 3x, it's almost certainly mismatched symbols
    const ratio = currentPrice / expectedEntry;
    const priceMagnitudeMismatch = ratio > 3.0 || ratio < 0.33;

    if (symbolMismatch || priceMagnitudeMismatch) {
      console.error(
        `[DRIFT-PROTECTION-ALERT] Impossible drift/mismatch detected! ` +
        `Symbol: ${proposal.symbol}. ` +
        `Expected Entry: ${expectedEntry.toFixed(4)}, Current Price: ${currentPrice.toFixed(4)}. ` +
        `Symbol Mismatch: ${symbolMismatch}, Price Ratio: ${ratio.toFixed(4)}. ` +
        `Magnitude Mismatch: ${priceMagnitudeMismatch}. ` +
        `Capping drift to 100% (10,000 BPS) to force rejection.`
      );
      entryDriftBps = 10_000;
    } else {
      // Formula: driftPercent = abs(currentPrice - expectedEntry) / expectedEntry * 100
      const rawDriftPercent = (Math.abs(currentPrice - expectedEntry) / expectedEntry) * 100;

      if (rawDriftPercent > 100) {
        console.error(
          `[DRIFT-PROTECTION-ALERT] Impossible raw drift percent > 100%! ` +
          `Symbol: ${proposal.symbol}. ` +
          `Expected Entry: ${expectedEntry.toFixed(4)}, Current Price: ${currentPrice.toFixed(4)}. ` +
          `Calculated Drift: ${rawDriftPercent.toFixed(4)}%. ` +
          `Capping to 100% (10,000 BPS) to force rejection.`
        );
        entryDriftBps = 10_000;
      } else {
        // Normal drift calculation: round to basis points (1% = 100 bps) to prevent decimal precision errors
        entryDriftBps = Math.round(rawDriftPercent * 100);
      }
    }

    console.info(
      `[DRIFT-CALCULATION] Symbol: ${proposal.symbol}, ` +
      `expectedEntry: ${expectedEntry.toFixed(4)}, ` +
      `currentPrice: ${currentPrice.toFixed(4)}, ` +
      `drift: ${(entryDriftBps / 100).toFixed(4)}% (${entryDriftBps} BPS)`
    );
  }

  const vol = proposal.atrPct ?? 0;
  const volatilityScore = Math.max(0, Math.min(100, vol * 10));
  return {
    expectedProfitPercent,
    expectedLossPercent,
    riskRewardRatio,
    entryDriftBps,
    volatilityScore,
  };
}

/**
 * Soft warnings — degrade the score but don't block the trade. Surfaced in
 * the assessment so the UI can show "executed despite X" hints.
 */
function collectWarnings(
  proposal: TradeProposal,
  metrics: DerivedMetrics,
  thresholds: Thresholds,
): QualityWarning[] {
  const warnings: QualityWarning[] = [];
  if (metrics.riskRewardRatio < thresholds.preferredRiskRewardRatio) {
    warnings.push({
      code: "rr_below_preferred",
      message: `RR ${metrics.riskRewardRatio.toFixed(2)} below preferred ${thresholds.preferredRiskRewardRatio}`,
    });
  }
  if (proposal.atrPct != null && proposal.atrPct > thresholds.maxVolatilityThreshold * 0.75) {
    warnings.push({
      code: "vol_elevated",
      message: `ATR ${proposal.atrPct.toFixed(2)}% approaches volatility ceiling`,
    });
  }
  if (proposal.decision.setupQuality === "B" || proposal.decision.setupQuality === "B+") {
    warnings.push({
      code: "mid_setup_quality",
      message: `LLM graded setup ${proposal.decision.setupQuality}`,
    });
  }
  return warnings;
}

/**
 * The single entry point. Engines call `assessTradeQuality(proposal)` and
 * either fire the order (when `approved`) or log the structured rejection.
 *
 * Validators are evaluated in order but ALL failures are collected — the
 * audit log benefits from seeing every reason a trade was blocked, not just
 * the first one. Engines that want fast-path rejection can early-return on
 * `rejections.length > 0`.
 */
export function assessTradeQuality(
  proposal: TradeProposal,
  thresholdOverrides?: Partial<Thresholds>,
): TradeAssessment {
  const thresholds: Thresholds = {
    ...resolveThresholds(proposal.marketRegime),
    ...thresholdOverrides,
  };
  const metrics = deriveMetrics(proposal);
  const score = scoreTrade(proposal, metrics);

  const rejections = VALIDATORS.map((v) =>
    v.evaluate(proposal, metrics, thresholds),
  ).filter((r): r is NonNullable<typeof r> => r !== null);

  return {
    approved: rejections.length === 0,
    rejections,
    warnings: collectWarnings(proposal, metrics, thresholds),
    metrics,
    score,
    llmSetupQuality: proposal.decision.setupQuality,
  };
}
