import type { IndicatorContext, MarketRegime, StrategyCategory } from "../types";

/**
 * Market regime classifier.
 *
 * Single source of truth for regime labels. The legacy `detectRegime` in
 * `signal-engine.ts` returns the user-visible `MarketCondition` union; this
 * module returns the strategy-framework `MarketRegime` union which carries
 * the extra regimes (Low Volatility, Reversal, Breakout) used to weight
 * strategy outputs.
 *
 * Heuristics are intentionally conservative — the LLM is the final
 * arbiter, this layer just provides a structured prior.
 */
export function classifyRegime(ind: IndicatorContext): MarketRegime {
  const { atrPct, adx14, ema50, ema200, rsi14, bb, realizedVol } = ind;

  // 1) High vol dominates everything — anything above ~3% ATR is "wild".
  if ((atrPct ?? 0) >= 3) return "High Volatility";

  // 2) Low vol — calm tape, both ATR and realized vol depressed.
  if ((atrPct ?? Infinity) < 0.6 && (realizedVol ?? Infinity) < 0.012) {
    return "Low Volatility";
  }

  // 3) Strong directional trend — ADX gates the read.
  if (ema50 != null && ema200 != null && (adx14 ?? 0) >= 22) {
    if (ema50 > ema200) return "Trending Up";
    if (ema50 < ema200) return "Trending Down";
  }

  // 4) Breakout — price punched outside the upper or lower Bollinger band
  //    with rising ADX. We don't have last-close here, but band width + adx
  //    >= 25 is a reasonable proxy when paired with high momentum.
  if (bb && (adx14 ?? 0) >= 25) {
    const bandWidth = (bb.upper - bb.lower) / bb.middle;
    if (bandWidth > 0.03) return "Breakout";
  }

  // 5) Reversal — RSI extreme + ADX cooling = mean-reversion candidate.
  if ((rsi14 ?? 50) >= 72 && (adx14 ?? 0) < 25) return "Reversal";
  if ((rsi14 ?? 50) <= 28 && (adx14 ?? 0) < 25) return "Reversal";

  // 6) Choppy — low ADX, no clear EMA stack.
  if ((adx14 ?? 0) < 18) return "Choppy";

  return "Sideways";
}

/**
 * Per-category weight in the current regime. Multipliers are intentionally
 * blunt (0.3 / 0.7 / 1.0 / 1.2 / 1.4) — they nudge ranking without letting
 * the regime engine override a strong strategy signal entirely.
 *
 * Values reflect well-documented empirical priors:
 *   - momentum + trend-following dominate trending regimes
 *   - mean-reversion + statistical dominate sideways / choppy / reversal
 *   - volatility strategies pop in high-vol regimes
 *   - breakout strategies pop in breakout regimes and die in chop
 */
export function regimeWeightFor(
  category: StrategyCategory,
  regime: MarketRegime,
): number {
  const table: Record<MarketRegime, Partial<Record<StrategyCategory, number>>> = {
    "Trending Up": {
      momentum: 1.4,
      "trend-following": 1.4,
      breakout: 1.2,
      "market-structure": 1.0,
      sentiment: 1.0,
      "mean-reversion": 0.5,
      statistical: 0.7,
      volatility: 0.7,
      arbitrage: 0.8,
    },
    "Trending Down": {
      momentum: 1.4,
      "trend-following": 1.4,
      breakout: 1.2,
      "market-structure": 1.0,
      sentiment: 1.0,
      "mean-reversion": 0.5,
      statistical: 0.7,
      volatility: 0.9,
      arbitrage: 0.8,
    },
    Sideways: {
      "mean-reversion": 1.4,
      statistical: 1.3,
      "market-structure": 1.1,
      sentiment: 0.9,
      momentum: 0.5,
      "trend-following": 0.5,
      breakout: 0.7,
      volatility: 0.8,
      arbitrage: 1.1,
    },
    Choppy: {
      "mean-reversion": 1.2,
      statistical: 1.2,
      arbitrage: 1.0,
      sentiment: 0.7,
      momentum: 0.4,
      "trend-following": 0.4,
      breakout: 0.5,
      volatility: 0.9,
      "market-structure": 0.7,
    },
    "High Volatility": {
      volatility: 1.4,
      breakout: 1.2,
      momentum: 1.0,
      "trend-following": 1.0,
      sentiment: 1.0,
      "mean-reversion": 0.6,
      statistical: 0.7,
      arbitrage: 0.7,
      "market-structure": 0.8,
    },
    "Low Volatility": {
      "mean-reversion": 1.3,
      statistical: 1.2,
      "market-structure": 1.1,
      sentiment: 1.0,
      momentum: 0.8,
      "trend-following": 0.9,
      breakout: 0.7,
      volatility: 0.6,
      arbitrage: 1.0,
    },
    Breakout: {
      breakout: 1.4,
      momentum: 1.3,
      "trend-following": 1.2,
      volatility: 1.1,
      "market-structure": 1.0,
      sentiment: 0.9,
      "mean-reversion": 0.4,
      statistical: 0.6,
      arbitrage: 0.7,
    },
    Reversal: {
      "mean-reversion": 1.4,
      statistical: 1.2,
      "market-structure": 1.1,
      sentiment: 0.9,
      volatility: 1.0,
      momentum: 0.5,
      "trend-following": 0.5,
      breakout: 0.6,
      arbitrage: 0.9,
    },
  };
  return table[regime][category] ?? 1.0;
}
