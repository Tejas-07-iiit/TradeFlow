import type { DecisionInput, MarketDecision } from "../schemas";
import type { LlmTier } from "../providers";

export interface DecisionPrefilter {
  skip: boolean;
  tier?: LlmTier;
  reason: string;
  syntheticDecision?: MarketDecision;
}

const FLAT_ALIGNMENT_THRESHOLD = 65;
const NO_TREND_ADX_THRESHOLD = 20;
const NEUTRAL_RSI_MIN = 45;
const NEUTRAL_RSI_MAX = 55;
const MIN_ATR_PCT = 0.35; // low volatility floor in %
/**
 * Below this effective-N, "consensus" is actually one orthogonality cluster
 * speaking (typically trend) and the alignment score is meaningless. Reject
 * regardless of how high `alignmentScore` looks. 1.8 ensures confirmation
 * across multiple independent strategy families.
 */
const MIN_EFFECTIVE_N = 1.8;

export function prefilterDecision(input: DecisionInput): DecisionPrefilter {
  const snap = input.strategySnapshot;
  const hasOpenPosition = !!input.portfolio?.hasOpenPositionThisSymbol;
  const price = input.price;
  const regime = input.marketRegime;

  // Active positions must NEVER be skipped by the prefilter as stop-loss/take-profit
  // adjustments and exit validation require continuous monitoring.
  if (hasOpenPosition) {
    // Open positions: MID tier by default; PREMIUM only when alignment
    // crosses the elite threshold (and the trade is hot enough to justify
    // burning the heavyweight quota).
    const isElite = snap && snap.alignmentScore >= 80;
    return {
      skip: false,
      tier: isElite ? "premium" : "mid",
      reason: `active position tracking (align=${snap?.alignmentScore ?? 0})`,
    };
  }

  // 1. If strategy snapshot is missing, skip the LLM execution.
  if (!snap) {
    return {
      skip: true,
      reason: "missing strategy snapshot",
      syntheticDecision: buildSyntheticHold(price, regime, "Skipped LLM: Strategy snapshot is missing."),
    };
  }

  // 2. Reject setups with poor alignment score.
  if (snap.alignmentScore < FLAT_ALIGNMENT_THRESHOLD) {
    return {
      skip: true,
      reason: `flat strategy alignment (score=${snap.alignmentScore.toFixed(0)} < ${FLAT_ALIGNMENT_THRESHOLD})`,
      syntheticDecision: buildSyntheticHold(price, regime, `Skipped LLM: Low strategy alignment score (${snap.alignmentScore.toFixed(0)}).`),
    };
  }

  // 3. Reject setups with no directional conviction.
  if (Math.abs(snap.netDirection) < 10) {
    return {
      skip: true,
      reason: `low net directional conviction (netDirection=${snap.netDirection.toFixed(0)} < 10)`,
      syntheticDecision: buildSyntheticHold(price, regime, `Skipped LLM: Directional conviction too low (${snap.netDirection.toFixed(0)}).`),
    };
  }

  // 3b. Reject single-factor consensus: even if alignment looks strong, when
  // effectiveN < 1.3 the agreement is coming from one orthogonality cluster
  // (typically the trend family — 10 EMA/Supertrend variants firing at once
  // on the same latent factor). That's not consensus, that's one signal in
  // ten costumes. Sit out.
  if (snap.effectiveN < MIN_EFFECTIVE_N) {
    return {
      skip: true,
      reason: `single-factor consensus (effectiveN=${snap.effectiveN.toFixed(2)} < ${MIN_EFFECTIVE_N})`,
      syntheticDecision: buildSyntheticHold(
        price,
        regime,
        `Skipped LLM: Apparent consensus is single-factor (effectiveN=${snap.effectiveN.toFixed(2)}). One family is speaking; no orthogonal confirmation.`,
      ),
    };
  }

  // 4. Reject setups in sideways chop with no trend (low ADX + neutral RSI).
  const adx = input.indicators.adx14;
  const rsi = input.indicators.rsi14;
  if (
    adx != null && adx < NO_TREND_ADX_THRESHOLD &&
    rsi != null && rsi >= NEUTRAL_RSI_MIN && rsi <= NEUTRAL_RSI_MAX
  ) {
    return {
      skip: true,
      reason: `sideways chop detected (adx=${adx.toFixed(1)} < ${NO_TREND_ADX_THRESHOLD}, rsi=${rsi.toFixed(1)} neutral)`,
      syntheticDecision: buildSyntheticHold(price, regime, `Skipped LLM: Market is in range-bound sideways consolidation with no trend.`),
    };
  }

  // 5. Reject setups with near-zero volatility to avoid paying exchange fees on dead action.
  const atrPct = input.indicators.atrPct;
  if (atrPct != null && atrPct < MIN_ATR_PCT && snap.alignmentScore < 70) {
    return {
      skip: true,
      reason: `extremely low volatility (atrPct=${atrPct.toFixed(2)}% < ${MIN_ATR_PCT}%)`,
      syntheticDecision: buildSyntheticHold(price, regime, `Skipped LLM: Volatility is too low to cover slippage and fees.`),
    };
  }

  // 5b. Suppress entries during Choppy, Sideways, and Low Volatility regimes unless setup is exceptional.
  if (regime) {
    const rLower = regime.toLowerCase();
    const isChopOrLowVol = rLower.includes("choppy") || rLower.includes("low volatility") || rLower.includes("sideways");
    if (isChopOrLowVol) {
      if (snap.alignmentScore < 80) {
        return {
          skip: true,
          reason: `suppressed entry in chop/low-vol regime (regime=${regime}, alignment=${snap.alignmentScore.toFixed(0)} < 80)`,
          syntheticDecision: buildSyntheticHold(
            price,
            regime,
            `Skipped LLM: Suppressed entry in ${regime} regime (requires >=80% strategy alignment to trade in choppy/low-vol markets).`,
          ),
        };
      }
    }
  }


  // 6. Premium Routing for Elite Setups. Only promote to the heavyweight
  // model when alignment is high AND it's coming from multiple orthogonal
  // clusters — otherwise the spend is on theatre.
  if (
    snap.alignmentScore >= 75 &&
    Math.abs(snap.netDirection) >= 25 &&
    snap.effectiveN >= 2.0
  ) {
    return {
      skip: false,
      tier: "premium",
      reason: `elite setup (align=${snap.alignmentScore.toFixed(0)}, netDir=${snap.netDirection.toFixed(0)}, effN=${snap.effectiveN.toFixed(2)})`,
    };
  }

  // 7. Routine setups → MID tier (gpt-oss-20b / qwen3-32b). The LIGHT
  // pool is never reached directly here; it's reserved for news/sentiment
  // and serves as the downgrade target only when MID is exhausted.
  return {
    skip: false,
    tier: "mid",
    reason: `routine setup (align=${snap.alignmentScore.toFixed(0)})`,
  };
}

function buildSyntheticHold(price: number, regime: string, reasonText: string): MarketDecision {
  return {
    decision: "HOLD",
    confidence: 30,
    setupQuality: "C",
    riskLevel: "Low",
    executeTrade: false,
    positionSizePercent: 0,
    expectedHoldTimeMinutes: 5,
    entryPrice: price,
    takeProfit: price,
    stopLoss: price,
    reasoning: [
      reasonText,
      "Deterministic pre-filter blocked LLM coordination to protect token quota."
    ],
    warnings: [],
    marketSummary: `Skipped LLM coordinator in ${regime} regime — market conditions do not support entry.`,
    alignedStrategies: [],
    conflictingStrategies: [],
    marketConditions: `${regime} regime, failed pre-filter criteria`,
    executionRecommendation: "skip",
  };
}
