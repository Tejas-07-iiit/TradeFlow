import type { StrategyContext, StrategyDefinition, StrategyOutput } from "@/strategy-core/types";

/**
 * Volatility-aware position filter.
 *
 * Combines two Quantpedia insights:
 *   - "Low Volatility Factor Effect": low-vol assets earn higher
 *     risk-adjusted returns. Translated to a single-asset tape: prefer trades
 *     when realized vol is *moderate*, abstain when it's extreme.
 *   - "Volatility Risk Premium Effect": elevated implied vol forecasts
 *     mean reversion. Treat very high ATR% as a flag for caution and a tilt
 *     toward mean-reversion bias.
 *
 * Output is more a directional bias modifier than a primary entry — its
 * confidence stays moderate so it doesn't crowd out higher-conviction
 * trend/momentum strategies.
 */
function evaluate(ctx: StrategyContext): StrategyOutput {
  const { atrPct, realizedVol, rsi14 } = ctx.indicators;
  const reasoning: string[] = [];

  if (atrPct == null) {
    return shell({
      signal: "HOLD",
      confidence: 25,
      reasoning: ["ATR% not available."],
      volatilityScore: 50,
    });
  }

  const vol = atrPct;
  let signal: StrategyOutput["signal"] = "HOLD";
  let confidence = 35;
  let volatilityScore = Math.min(100, vol * 30);

  if (vol >= 3.5) {
    reasoning.push(`ATR% ${vol.toFixed(2)}% — wild regime. Mean-reversion bias.`);
    if ((rsi14 ?? 50) >= 70) {
      signal = "SELL";
      confidence = 55;
    } else if ((rsi14 ?? 50) <= 30) {
      signal = "BUY";
      confidence = 55;
    } else {
      reasoning.push("RSI mid-range — no directional fade yet.");
    }
  } else if (vol < 0.6 && (realizedVol ?? 0) < 0.012) {
    reasoning.push(
      `ATR% ${vol.toFixed(2)}% with realized vol ${(realizedVol ?? 0).toFixed(4)} — low-vol regime. Expect range; favour fade trades.`,
    );
    confidence = 45;
    volatilityScore = 25;
  } else {
    reasoning.push(`ATR% ${vol.toFixed(2)}% — normal regime, no volatility tilt.`);
  }

  return shell({ signal, confidence, reasoning, volatilityScore });
}

function shell(args: {
  signal: StrategyOutput["signal"];
  confidence: number;
  reasoning: string[];
  volatilityScore: number;
}): StrategyOutput {
  return {
    strategyId: "volatility-regime",
    strategyName: "Volatility Regime Filter",
    category: "volatility",
    signal: args.signal,
    confidence: Math.round(Math.min(85, Math.max(0, args.confidence))),
    timeframe: "intraday",
    regimeFit: ["High Volatility", "Low Volatility", "Reversal"],
    riskLevel: args.volatilityScore > 70 ? "High" : "Medium",
    reasoning: args.reasoning,
    indicatorsUsed: ["ATR%", "Realized volatility", "RSI14"],
    entryConditions: [
      "Extreme ATR% (>3.5) with RSI extreme — mean-reversion fade",
      "Sub-0.6% ATR — flag low-vol grind",
    ],
    exitConditions: ["Vol normalises", "RSI returns to mid-range"],
    stopLossLogic: "Wider stop in high-vol; tighter in low-vol.",
    takeProfitLogic: "Half-position partial at 1× ATR; runner to mean.",
    volatilityScore: args.volatilityScore,
    momentumScore: 0,
    trendScore: 0,
  };
}

export const VolatilityRegime: StrategyDefinition = {
  id: "volatility-regime",
  name: "Volatility Regime Filter",
  category: "volatility",
  description:
    "Encodes the low-vol-factor and vol-risk-premium principles as a directional bias modifier.",
  timeframes: ["intraday"],
  preferredRegimes: ["High Volatility", "Low Volatility", "Reversal"],
  minCandles: 40,
  evaluate,
  enabled: true,
};
