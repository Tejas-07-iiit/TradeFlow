import type {
  DerivedMetrics,
  Grade,
  QualityScore,
  TradeProposal,
} from "./types";

/**
 * Weighted scoring model. Every executable trade gets a 0-100 score and a
 * letter grade, regardless of whether validators rejected it — the operator
 * can audit "this trade barely missed" rejections from the score alone.
 *
 * Weights add up to 100. They were chosen so RR + confidence carry the most
 * weight (those are the cleanest signals), with regime + volatility shaping
 * the tail of the distribution.
 */
const WEIGHTS = {
  riskReward: 25,
  confidence: 20,
  expectedProfit: 12,
  setupQuality: 15,
  regime: 10,
  volatility: 10,
  strategyAlignment: 8,
} as const;

const REGIME_BONUS: Record<string, number> = {
  Trending: 100,
  Sideways: 80,
  Compression: 75,
  Choppy: 40,
  "High Volatility": 30,
};

const SETUP_QUALITY_BONUS: Record<string, number> = {
  "A+": 100,
  A: 85,
  "B+": 70,
  B: 55,
  C: 30,
  Avoid: 0,
};

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function gradeFor(score: number): Grade {
  if (score >= 85) return "A+";
  if (score >= 72) return "A";
  if (score >= 58) return "B";
  if (score >= 42) return "C";
  return "D";
}

/**
 * Score the proposal on its own merits. The scorer does not know about
 * threshold cutoffs — that's the validator's job. It only knows "the higher
 * the better" for each factor.
 */
export function scoreTrade(
  proposal: TradeProposal,
  derived: DerivedMetrics,
): QualityScore {
  // RR: linear ramp from 1.0 (0 points) to 3.0 (100 points), clamped.
  const rrPoints = clamp(((derived.riskRewardRatio - 1) / 2) * 100, 0, 100);

  // Confidence is already 0-100.
  const confPoints = clamp(proposal.decision.confidence, 0, 100);

  // Expected profit: ramp from 1% (0 points) to 6% (100 points).
  const epPoints = clamp(((derived.expectedProfitPercent - 1) / 5) * 100, 0, 100);

  // LLM-emitted setup quality bonus.
  const sqPoints = SETUP_QUALITY_BONUS[proposal.decision.setupQuality] ?? 50;

  // Regime: pre-tabled bonus for known regimes, mid-50 fallback.
  const regimePoints = REGIME_BONUS[proposal.marketRegime] ?? 50;

  // Volatility: penalty as ATR% climbs. Below 2% gets full marks, 8%+ gets 0.
  const vol = proposal.atrPct ?? 2;
  const volPoints = clamp(((8 - vol) / 6) * 100, 0, 100);

  // Strategy alignment: aligned − conflicting, normalised by total.
  const aligned = proposal.decision.alignedStrategies?.length ?? 0;
  const conflicting = proposal.decision.conflictingStrategies?.length ?? 0;
  const total = aligned + conflicting;
  const alignPoints = total === 0 ? 50 : clamp(((aligned - conflicting) / total) * 50 + 50, 0, 100);

  const factors = [
    { name: "Risk/Reward", weight: WEIGHTS.riskReward, score: rrPoints },
    { name: "Confidence", weight: WEIGHTS.confidence, score: confPoints },
    { name: "Expected Profit", weight: WEIGHTS.expectedProfit, score: epPoints },
    { name: "LLM Setup Grade", weight: WEIGHTS.setupQuality, score: sqPoints },
    { name: "Regime Fit", weight: WEIGHTS.regime, score: regimePoints },
    { name: "Volatility", weight: WEIGHTS.volatility, score: volPoints },
    { name: "Strategy Alignment", weight: WEIGHTS.strategyAlignment, score: alignPoints },
  ];

  const weightSum = factors.reduce((s, f) => s + f.weight, 0);
  const value = factors.reduce((s, f) => s + (f.score * f.weight) / weightSum, 0);

  return {
    value: Math.round(value * 10) / 10,
    grade: gradeFor(value),
    factors,
  };
}
