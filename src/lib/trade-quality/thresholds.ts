import type { Thresholds } from "./types";

/**
 * Institutional defaults. These are the tightest filters; regime-specific
 * overrides loosen or tighten individual fields in `resolveThresholds()`.
 *
 * Why these numbers:
 *   - minExpectedProfitPercent 2  — fees + slippage + frustration tax. Trades
 *     targeting <2% rarely pay for themselves on retail-grade infra.
 *   - minRiskRewardRatio 1.8      — even a 50% win-rate strategy is unprofitable
 *     below ~1.5 RR after costs. 1.8 leaves headroom.
 *   - preferredRiskRewardRatio 2.5 — used by the scorer (not the rejector).
 *   - minConfidence 72            — LLM confidence is noisy under 70; 72 is the
 *     empirical inflection where the win-rate distribution stops being flat.
 *   - maxVolatilityThreshold 8    — ATR% > 8 in crypto is "running spot" — risk
 *     ratios become unstable and stops trigger on noise.
 */
export const DEFAULT_THRESHOLDS: Thresholds = {
  minExpectedProfitPercent: 2,
  minRiskRewardRatio: 1.8,
  preferredRiskRewardRatio: 2.5,
  minConfidence: 72,
  maxRiskPerTradePercent: 1,
  maxVolatilityThreshold: 8,
  maxOpenPositions: 4,
  perSymbolEntryCooldownMs: 5 * 60 * 1000,
  maxEntryDriftBps: 100, // 1.00%
  minAvailableBalance: 50,
};

/**
 * Per-regime overrides. A trending tape *can* support a thinner RR because
 * momentum-continuation has a higher hit-rate; a choppy tape needs the
 * opposite. High-volatility regimes lower the ATR cap explicitly to keep the
 * validator consistent with what a human risk manager would do.
 */
export const REGIME_OVERRIDES: Record<string, Partial<Thresholds>> = {
  Trending: {
    minRiskRewardRatio: 1.5,
    minConfidence: 68,
  },
  Sideways: {
    minRiskRewardRatio: 2.0,
    minConfidence: 72,
  },
  Compression: {
    minRiskRewardRatio: 2.0,
    minConfidence: 74,
  },
  Choppy: {
    minRiskRewardRatio: 2.5,
    minConfidence: 78,
    minExpectedProfitPercent: 2.5,
  },
  "High Volatility": {
    minRiskRewardRatio: 2.5,
    minConfidence: 80,
    maxVolatilityThreshold: 6,
    minExpectedProfitPercent: 3,
  },
};

/**
 * Build the active threshold bundle for a regime. Unknown regimes fall back
 * to defaults — the rule is "be conservative when in doubt."
 */
export function resolveThresholds(
  regime: string,
  base: Thresholds = DEFAULT_THRESHOLDS,
): Thresholds {
  const overrides = REGIME_OVERRIDES[regime] ?? {};
  return { ...base, ...overrides };
}
