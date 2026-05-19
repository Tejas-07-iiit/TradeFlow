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
  const entryDriftBps =
    proposal.livePrice > 0
      ? (Math.abs(entryPrice - proposal.livePrice) / proposal.livePrice) * 10_000
      : 0;
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
