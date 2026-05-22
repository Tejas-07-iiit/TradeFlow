import type { StrategyContext, StrategyDefinition, StrategyOutput } from "@/strategy-core/types";

import { countDirection, supertrendTrio } from "./_supertrend-trio";

/**
 * MS HyperSupertrend — 3-Supertrend consensus (2 of 3) gated by EMA200 macro.
 *
 * The triple gives three independent reads on the trend; requiring two
 * agreements keeps the strategy from chasing the most sensitive Supertrend
 * during chop while still firing earlier than the all-three variant.
 */
function evaluate(ctx: StrategyContext): StrategyOutput {
  const { ema200 } = ctx.indicators;
  const reasoning: string[] = [];

  if (ctx.candles.length < 60 || ema200 == null) {
    return shell({
      signal: "HOLD",
      confidence: 25,
      reasoning: ["Need ≥60 bars and EMA200 to evaluate."],
      trendScore: 0,
      bull: 0,
      bear: 0,
    });
  }

  const votes = supertrendTrio(ctx.candles);
  if (votes.length < 3) {
    return shell({
      signal: "HOLD",
      confidence: 25,
      reasoning: ["Supertrend trio not yet stable."],
      trendScore: 0,
      bull: 0,
      bear: 0,
    });
  }

  const bull = countDirection(votes, 1);
  const bear = countDirection(votes, -1);
  const price = ctx.price;
  let signal: StrategyOutput["signal"] = "HOLD";
  let confidence = 35;
  let trendScore = 0;

  if (bull >= 2 && price > ema200) {
    signal = "BUY";
    confidence = bull === 3 ? 78 : 65;
    trendScore = bull === 3 ? 75 : 60;
    reasoning.push(
      `${bull}/3 Supertrends green and price ${price.toFixed(2)} > EMA200 ${ema200.toFixed(2)}.`,
    );
  } else if (bear >= 2 && price < ema200) {
    signal = "SELL";
    confidence = bear === 3 ? 78 : 65;
    trendScore = bear === 3 ? -75 : -60;
    reasoning.push(
      `${bear}/3 Supertrends red and price ${price.toFixed(2)} < EMA200 ${ema200.toFixed(2)}.`,
    );
  } else {
    reasoning.push(
      `Supertrend votes split (${bull} green, ${bear} red) or macro EMA200 disagrees — no trade.`,
    );
  }

  return shell({ signal, confidence, reasoning, trendScore, bull, bear });
}

function shell(args: {
  signal: StrategyOutput["signal"];
  confidence: number;
  reasoning: string[];
  trendScore: number;
  bull: number;
  bear: number;
}): StrategyOutput {
  return {
    strategyId: "hyper-supertrend",
    strategyName: "MS HyperSupertrend (2/3)",
    category: "trend-following",
    signal: args.signal,
    confidence: Math.round(Math.min(90, Math.max(0, args.confidence))),
    timeframe: "intraday",
    regimeFit: ["Trending Up", "Trending Down", "Breakout"],
    riskLevel: "Medium",
    reasoning: args.reasoning,
    indicatorsUsed: ["Supertrend(10,1)", "Supertrend(11,2)", "Supertrend(12,3)", "EMA200"],
    entryConditions: [
      "≥2 of 3 Supertrends agree on direction",
      "Price aligned with EMA200 macro",
    ],
    exitConditions: ["Majority Supertrends flip to opposite color"],
    stopLossLogic: "Furthest active Supertrend line on the trade side.",
    takeProfitLogic: "Trail the slowest Supertrend.",
    volatilityScore: 60,
    momentumScore: args.trendScore * 0.7,
    trendScore: args.trendScore,
  };
}

export const HyperSupertrend: StrategyDefinition = {
  id: "hyper-supertrend",
  name: "MS HyperSupertrend (2/3)",
  category: "trend-following",
  description:
    "Triple-Supertrend consensus (2-of-3 majority) gated by EMA200 — aggressive trend entry with single-indicator noise filtered out.",
  timeframes: ["intraday"],
  preferredRegimes: ["Trending Up", "Trending Down", "Breakout"],
  minCandles: 60,
  evaluate,
  enabled: true,
};
