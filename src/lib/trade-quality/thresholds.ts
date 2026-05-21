import type { Thresholds } from "./types";

/**
 * Institutional defaults. These are the tightest filters; regime-specific
 * overrides loosen or tighten individual fields in `resolveThresholds()`.
 *
 * Why these numbers:
 *   - minExpectedProfitPercent 0   — Removed. The AI is free to take any +EV trade regardless of target size.
 *   - minRiskRewardRatio 1.0       — Scalping strategies often target 1:1 risk-reward profiles.
 *     1.0 allows parity trades to clear validation.
 *   - preferredRiskRewardRatio 2.0 — used by the scorer (not the rejector).
 *   - minConfidence 72            — LLM confidence is noisy under 70; 72 is the
 *     empirical inflection where the win-rate distribution stops being flat.
 *   - maxVolatilityThreshold 8    — ATR% > 8 in crypto is "running spot" — risk
 *     ratios become unstable and stops trigger on noise.
 */
export const DEFAULT_THRESHOLDS: Thresholds = {
  minExpectedProfitPercent: 0,
  minRiskRewardRatio: 0.9,
  preferredRiskRewardRatio: 2.0,
  minConfidence: 58,
  maxRiskPerTradePercent: 1,
  maxVolatilityThreshold: 10,
  maxOpenPositions: 4,
  perSymbolEntryCooldownMs: 5 * 60 * 1000,
  maxEntryDriftBps: 200, // 2.00% — accommodates LLM rounding + 0.5×ATR drift
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
    minRiskRewardRatio: 0.9,
    minConfidence: 55,
  },
  Sideways: {
    minRiskRewardRatio: 0.9,
    minConfidence: 58,
  },
  Compression: {
    minRiskRewardRatio: 0.9,
    minConfidence: 60,
  },
  Choppy: {
    minRiskRewardRatio: 1.0,
    minConfidence: 62,
  },
  "High Volatility": {
    minRiskRewardRatio: 1.0,
    minConfidence: 65,
    maxVolatilityThreshold: 9,
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
