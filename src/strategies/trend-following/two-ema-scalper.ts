import { ema, lastNumber } from "@/lib/indicators/calculations";
import type { StrategyContext, StrategyDefinition, StrategyOutput } from "@/strategy-core/types";

/**
 * "Scalping the Bull" — 10 EMA / 60 EMA crossover tuned for bullish crypto
 * scalping. We keep the long-only ergonomics (bear-mode whipsaws are brutal)
 * but emit SELL when the 10 < 60 cross occurs *and* macro EMA200 has rolled
 * over, so the strategy can short clean downtrends.
 */
const FAST = 10;
const SLOW = 60;

function evaluate(ctx: StrategyContext): StrategyOutput {
  const closes = ctx.candles.map((c) => c.close);
  const reasoning: string[] = [];
  if (closes.length < SLOW + 5) {
    return shell({
      signal: "HOLD",
      confidence: 25,
      reasoning: [`Need at least ${SLOW + 5} bars.`],
      trendScore: 0,
    });
  }

  const fastSeries = ema(closes, FAST);
  const slowSeries = ema(closes, SLOW);
  const fastNow = lastNumber(fastSeries);
  const slowNow = lastNumber(slowSeries);
  const fastPrev = fastSeries.at(-2) ?? null;
  const slowPrev = slowSeries.at(-2) ?? null;
  if (fastNow == null || slowNow == null || fastPrev == null || slowPrev == null) {
    return shell({
      signal: "HOLD",
      confidence: 25,
      reasoning: ["EMA pair not yet stable."],
      trendScore: 0,
    });
  }

  const justCrossedUp = fastPrev <= slowPrev && fastNow > slowNow;
  const justCrossedDown = fastPrev >= slowPrev && fastNow < slowNow;
  const stackedUp = fastNow > slowNow;
  const ema200 = ctx.indicators.ema200;

  let signal: StrategyOutput["signal"] = "HOLD";
  let confidence = 35;
  let trendScore = 0;

  if (justCrossedUp || (stackedUp && ema200 != null && ctx.price > ema200)) {
    signal = "BUY";
    confidence = justCrossedUp ? 75 : 60;
    trendScore = 65;
    reasoning.push(
      justCrossedUp
        ? `Fresh 10/60 EMA cross-up at ${fastNow.toFixed(2)}/${slowNow.toFixed(2)}.`
        : `10 EMA stacked above 60 EMA with EMA200 macro bullish.`,
    );
  } else if (justCrossedDown && ema200 != null && ctx.price < ema200) {
    signal = "SELL";
    confidence = 70;
    trendScore = -65;
    reasoning.push(
      `10/60 EMA cross-down with EMA200 macro bearish — short scalp.`,
    );
  } else {
    reasoning.push(
      `EMA stack ${stackedUp ? "bullish" : "bearish"} without a fresh cross — no scalp signal.`,
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
    strategyId: "two-ema-scalper",
    strategyName: "Two-EMA Bull Scalper (10/60)",
    category: "trend-following",
    signal: args.signal,
    confidence: Math.round(Math.min(90, Math.max(0, args.confidence))),
    timeframe: "intraday",
    regimeFit: ["Trending Up", "Breakout", "High Volatility"],
    riskLevel: "Medium",
    reasoning: args.reasoning,
    indicatorsUsed: ["EMA10", "EMA60", "EMA200"],
    entryConditions: [
      "Fresh 10 EMA cross of 60 EMA",
      "Macro EMA200 aligned with cross direction",
    ],
    exitConditions: ["10/60 EMA opposite cross", "Fixed 2-5% take profit"],
    stopLossLogic: "Below the 60 EMA or recent swing low.",
    takeProfitLogic: "Fixed 2-5% or trail with 10 EMA.",
    volatilityScore: 55,
    momentumScore: args.trendScore * 0.8,
    trendScore: args.trendScore,
  };
}

export const TwoEmaScalper: StrategyDefinition = {
  id: "two-ema-scalper",
  name: "Two-EMA Bull Scalper (10/60)",
  category: "trend-following",
  description:
    "Bull-market 10/60 EMA scalper — emits only when a fresh cross fires or the stack agrees with macro EMA200.",
  timeframes: ["intraday"],
  preferredRegimes: ["Trending Up", "Breakout", "High Volatility"],
  minCandles: 65,
  evaluate,
  enabled: true,
};
