import type { StrategyContext, StrategyDefinition, StrategyOutput } from "@/strategy-core/types";

import { countDirection, supertrendTrio } from "./_supertrend-trio";

/**
 * BEST Supertrend — stricter variant: requires *all three* Supertrends to
 * agree AND price to be on the right side of EMA200. Fewer signals, much
 * higher quality.
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
    });
  }

  const votes = supertrendTrio(ctx.candles);
  if (votes.length < 3) {
    return shell({
      signal: "HOLD",
      confidence: 25,
      reasoning: ["Supertrend trio not yet stable."],
      trendScore: 0,
    });
  }

  const bull = countDirection(votes, 1);
  const bear = countDirection(votes, -1);
  const price = ctx.price;
  let signal: StrategyOutput["signal"] = "HOLD";
  let confidence = 35;
  let trendScore = 0;

  if (bull === 3 && price > ema200) {
    signal = "BUY";
    confidence = 82;
    trendScore = 80;
    reasoning.push(
      `All 3 Supertrends green with price ${price.toFixed(2)} > EMA200 ${ema200.toFixed(2)} — full confirmation.`,
    );
  } else if (bear === 3 && price < ema200) {
    signal = "SELL";
    confidence = 82;
    trendScore = -80;
    reasoning.push(
      `All 3 Supertrends red with price ${price.toFixed(2)} < EMA200 ${ema200.toFixed(2)} — full confirmation.`,
    );
  } else {
    reasoning.push(
      `Need all 3 Supertrends to agree; got ${bull} green / ${bear} red.`,
    );
  }

  return shell({ signal, confidence, reasoning, trendScore });
}

function shell(args: {
  signal: StrategyOutput["signal"];
  confidence: number;
  reasoning: string[];
  trendScore: number;
}): StrategyOutput {
  return {
    strategyId: "best-supertrend",
    strategyName: "BEST Supertrend (3/3)",
    category: "trend-following",
    signal: args.signal,
    confidence: Math.round(Math.min(92, Math.max(0, args.confidence))),
    timeframe: "swing",
    regimeFit: ["Trending Up", "Trending Down"],
    riskLevel: "Low",
    reasoning: args.reasoning,
    indicatorsUsed: ["Supertrend(10,1)", "Supertrend(11,2)", "Supertrend(12,3)", "EMA200"],
    entryConditions: [
      "All 3 Supertrends agree on direction",
      "Price aligned with EMA200 macro",
    ],
    exitConditions: ["Any Supertrend flips to opposite color"],
    stopLossLogic: "Slowest Supertrend (period 12) on the trade side.",
    takeProfitLogic: "Trail the slowest Supertrend until flip.",
    volatilityScore: 50,
    momentumScore: args.trendScore * 0.6,
    trendScore: args.trendScore,
  };
}

export const BestSupertrend: StrategyDefinition = {
  id: "best-supertrend",
  name: "BEST Supertrend (3/3)",
  category: "trend-following",
  description:
    "Strict three-of-three Supertrend confluence gated by EMA200 — fewer signals, institutional-grade conviction.",
  timeframes: ["swing", "intraday"],
  preferredRegimes: ["Trending Up", "Trending Down"],
  minCandles: 60,
  evaluate,
  enabled: true,
};
