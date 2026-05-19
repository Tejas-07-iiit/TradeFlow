import type { StrategyContext, StrategyDefinition, StrategyOutput } from "@/strategy-core/types";

/**
 * Short-Term Reversal (Jegadeesh 1990).
 *
 * Quantpedia: "Short Term Reversal in Stocks" — 1-month losers tend to bounce.
 * Adapted intraday: when RSI prints an extreme (≥72 or ≤28) and price
 * stretches >1.5 ATRs from EMA20, fade the move.
 *
 * Critically, this strategy is INVERSE to momentum — it earns its weight in
 * sideways / reversal regimes and gets down-weighted in trending regimes.
 */
function evaluate(ctx: StrategyContext): StrategyOutput {
  const { rsi14, ema20, atr14 } = ctx.indicators;
  const price = ctx.price;
  const reasoning: string[] = [];

  if (rsi14 == null || ema20 == null || atr14 == null) {
    return shell({
      signal: "HOLD",
      confidence: 25,
      reasoning: ["Missing RSI / EMA20 / ATR — cannot grade stretch."],
      momentumScore: 0,
    });
  }

  const stretch = (price - ema20) / atr14;
  let signal: StrategyOutput["signal"] = "HOLD";
  let confidence = 35;
  let momentumScore = 0;

  if (rsi14 >= 72 && stretch > 1.5) {
    signal = "SELL";
    confidence = 55 + Math.min(30, (rsi14 - 70) * 2);
    momentumScore = -55;
    reasoning.push(
      `RSI ${rsi14.toFixed(1)} overbought; price stretched ${stretch.toFixed(2)} ATR above EMA20.`,
    );
    reasoning.push("Classical short-term-reversal short setup.");
  } else if (rsi14 <= 28 && stretch < -1.5) {
    signal = "BUY";
    confidence = 55 + Math.min(30, (30 - rsi14) * 2);
    momentumScore = 55;
    reasoning.push(
      `RSI ${rsi14.toFixed(1)} oversold; price stretched ${stretch.toFixed(2)} ATR below EMA20.`,
    );
    reasoning.push("Classical short-term-reversal long setup.");
  } else {
    reasoning.push(
      `RSI ${rsi14.toFixed(1)}, stretch ${stretch.toFixed(2)} ATR — no extreme to fade.`,
    );
  }

  return shell({ signal, confidence, reasoning, momentumScore });
}

function shell(args: {
  signal: StrategyOutput["signal"];
  confidence: number;
  reasoning: string[];
  momentumScore: number;
}): StrategyOutput {
  return {
    strategyId: "short-term-reversal",
    strategyName: "Short-Term Reversal",
    category: "mean-reversion",
    signal: args.signal,
    confidence: Math.round(Math.min(90, Math.max(0, args.confidence))),
    timeframe: "intraday",
    regimeFit: ["Sideways", "Choppy", "Reversal", "Low Volatility"],
    riskLevel: "Medium",
    reasoning: args.reasoning,
    indicatorsUsed: ["RSI14", "EMA20", "ATR14"],
    entryConditions: [
      "RSI ≥ 72 or ≤ 28",
      "Price stretched > 1.5 ATR from EMA20",
    ],
    exitConditions: ["RSI reverts to 50 band", "Price recloses on EMA20"],
    stopLossLogic: "0.8× ATR beyond the extreme.",
    takeProfitLogic: "Target EMA20 (~mean) on partial; 1.5× ATR on runner.",
    volatilityScore: 60,
    momentumScore: args.momentumScore,
    trendScore: -args.momentumScore * 0.5,
  };
}

export const ShortTermReversal: StrategyDefinition = {
  id: "short-term-reversal",
  name: "Short-Term Reversal",
  category: "mean-reversion",
  description:
    "Fades RSI extremes paired with a multi-ATR stretch — the intraday analogue of the 1-month reversal anomaly.",
  timeframes: ["intraday", "short-term"],
  preferredRegimes: ["Sideways", "Choppy", "Reversal", "Low Volatility"],
  minCandles: 40,
  evaluate,
  enabled: true,
};
