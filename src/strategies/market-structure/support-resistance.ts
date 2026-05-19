import type { StrategyContext, StrategyDefinition, StrategyOutput } from "@/strategy-core/types";

/**
 * Support / Resistance Sweep.
 *
 * Inspired by the order-flow literature on liquidity sweeps and the
 * Quantpedia "Pairs Trading" intuition that prices revert after touching
 * structural levels. We approximate intraday S/R as the recent 30-bar
 * high and low; a sweep is when the bar pierces the level intrabar but
 * closes back inside.
 *
 * BUY on a low sweep with bullish close.
 * SELL on a high sweep with bearish close.
 */
function evaluate(ctx: StrategyContext): StrategyOutput {
  const reasoning: string[] = [];
  const { candles } = ctx;
  if (candles.length < 31) {
    return shell({
      signal: "HOLD",
      confidence: 25,
      reasoning: ["Insufficient bars for S/R sweep."],
      momentumScore: 0,
    });
  }

  const window = candles.slice(-31, -1);
  const high = Math.max(...window.map((c) => c.high));
  const low = Math.min(...window.map((c) => c.low));
  const last = candles.at(-1)!;

  let signal: StrategyOutput["signal"] = "HOLD";
  let confidence = 35;
  let momentumScore = 0;

  const sweptLow = last.low < low && last.close > low;
  const sweptHigh = last.high > high && last.close < high;

  const body = last.close - last.open;
  const range = last.high - last.low || 1;
  const bodyRatio = Math.abs(body) / range;

  if (sweptLow && body > 0 && bodyRatio > 0.4) {
    signal = "BUY";
    confidence = 60;
    momentumScore = 50;
    reasoning.push(
      `Liquidity swept below ${low.toFixed(2)} then reclaimed with bullish ${(bodyRatio * 100).toFixed(0)}% body.`,
    );
  } else if (sweptHigh && body < 0 && bodyRatio > 0.4) {
    signal = "SELL";
    confidence = 60;
    momentumScore = -50;
    reasoning.push(
      `Liquidity swept above ${high.toFixed(2)} then rejected with bearish ${(bodyRatio * 100).toFixed(0)}% body.`,
    );
  } else {
    reasoning.push("No clean S/R sweep on the latest bar.");
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
    strategyId: "support-resistance-sweep",
    strategyName: "Support/Resistance Sweep",
    category: "market-structure",
    signal: args.signal,
    confidence: Math.round(Math.min(85, Math.max(0, args.confidence))),
    timeframe: "intraday",
    regimeFit: ["Reversal", "Sideways", "Choppy", "Trending Up", "Trending Down"],
    riskLevel: "Medium",
    reasoning: args.reasoning,
    indicatorsUsed: ["30-bar high/low", "Candle body ratio"],
    entryConditions: ["Wick beyond 30-bar extreme", "Close back inside the level", "Body ≥ 40% of range"],
    exitConditions: ["Mean of the recent range reached", "Sweep is taken back"],
    stopLossLogic: "Beyond the sweep wick.",
    takeProfitLogic: "Mean of 30-bar range on partial; full range on runner.",
    volatilityScore: 55,
    momentumScore: args.momentumScore,
    trendScore: args.momentumScore * 0.4,
  };
}

export const SupportResistanceSweep: StrategyDefinition = {
  id: "support-resistance-sweep",
  name: "Support/Resistance Sweep",
  category: "market-structure",
  description:
    "Detects intraday liquidity sweeps — wicks that pierce S/R then reclaim the level with a strong-bodied reversal close.",
  timeframes: ["intraday"],
  preferredRegimes: ["Reversal", "Sideways", "Choppy", "Trending Up", "Trending Down"],
  minCandles: 31,
  evaluate,
  enabled: true,
};
