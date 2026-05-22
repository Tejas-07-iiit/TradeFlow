import { lastNumber, sma } from "@/lib/indicators/calculations";
import type { StrategyContext, StrategyDefinition, StrategyOutput } from "@/strategy-core/types";

/**
 * Golden Cross / Death Cross — the textbook 50/200 SMA crossover.
 *
 * Reads SMA50 / SMA200 from IndicatorContext, but also recomputes the prior
 * bar to detect fresh crosses (vs steady-state alignment).
 */
function evaluate(ctx: StrategyContext): StrategyOutput {
  const { sma50, sma200 } = ctx.indicators;
  const reasoning: string[] = [];

  if (sma50 == null || sma200 == null) {
    return shell({
      signal: "HOLD",
      confidence: 25,
      reasoning: ["Need ≥200 bars for SMA200."],
      trendScore: 0,
    });
  }

  const closes = ctx.candles.map((c) => c.close);
  const sma50Series = sma(closes, 50);
  const sma200Series = sma(closes, 200);
  const prev50 = lastNumber(sma50Series.slice(0, -1));
  const prev200 = lastNumber(sma200Series.slice(0, -1));

  const golden = prev50 != null && prev200 != null && prev50 <= prev200 && sma50 > sma200;
  const death = prev50 != null && prev200 != null && prev50 >= prev200 && sma50 < sma200;
  const stackBull = sma50 > sma200;
  const stackBear = sma50 < sma200;

  let signal: StrategyOutput["signal"] = "HOLD";
  let confidence = 35;
  let trendScore = 0;

  if (golden) {
    signal = "BUY";
    confidence = 80;
    trendScore = 80;
    reasoning.push(
      `Golden Cross — SMA50 (${sma50.toFixed(2)}) crossed above SMA200 (${sma200.toFixed(2)}).`,
    );
  } else if (death) {
    signal = "SELL";
    confidence = 80;
    trendScore = -80;
    reasoning.push(
      `Death Cross — SMA50 (${sma50.toFixed(2)}) crossed below SMA200 (${sma200.toFixed(2)}).`,
    );
  } else if (stackBull) {
    signal = "BUY";
    confidence = 50;
    trendScore = 45;
    reasoning.push("Persistent SMA50 > SMA200 stack — macro uptrend intact.");
  } else if (stackBear) {
    signal = "SELL";
    confidence = 50;
    trendScore = -45;
    reasoning.push("Persistent SMA50 < SMA200 stack — macro downtrend intact.");
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
    strategyId: "golden-cross",
    strategyName: "Golden / Death Cross",
    category: "trend-following",
    signal: args.signal,
    confidence: Math.round(Math.min(90, Math.max(0, args.confidence))),
    timeframe: "position",
    regimeFit: ["Trending Up", "Trending Down"],
    riskLevel: "Low",
    reasoning: args.reasoning,
    indicatorsUsed: ["SMA50", "SMA200"],
    entryConditions: [
      "SMA50 crosses above SMA200 (Golden Cross — long)",
      "SMA50 crosses below SMA200 (Death Cross — short)",
    ],
    exitConditions: ["Opposite cross"],
    stopLossLogic: "Significant break of SMA200 in opposite direction.",
    takeProfitLogic: "Position-grade hold; trail SMA50.",
    volatilityScore: 30,
    momentumScore: args.trendScore * 0.5,
    trendScore: args.trendScore,
  };
}

export const GoldenCross: StrategyDefinition = {
  id: "golden-cross",
  name: "Golden / Death Cross",
  category: "trend-following",
  description:
    "Classic 50/200 SMA crossover — long-horizon macro filter. Boosts conviction on fresh crosses and quietly persists the stack signal between them.",
  timeframes: ["position", "monthly"],
  preferredRegimes: ["Trending Up", "Trending Down"],
  minCandles: 210,
  evaluate,
  enabled: true,
};
