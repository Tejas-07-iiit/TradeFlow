import type { StrategyContext, StrategyDefinition, StrategyOutput } from "@/strategy-core/types";

/**
 * Classic EMA cross + ADX confirmation.
 *
 * Aligns with several Quantpedia momentum/trend strategies (Sector Momentum,
 * Industry Momentum) by using a short EMA crossing a medium EMA as the
 * entry trigger and requiring ADX > 22 to filter out noise.
 */
function evaluate(ctx: StrategyContext): StrategyOutput {
  const { ema20, ema50, adx14, macd } = ctx.indicators;
  const reasoning: string[] = [];

  if (ema20 == null || ema50 == null) {
    return shell({
      signal: "HOLD",
      confidence: 25,
      reasoning: ["EMA20 / EMA50 not yet stable."],
      trendScore: 0,
    });
  }

  const adx = adx14 ?? 0;
  let signal: StrategyOutput["signal"] = "HOLD";
  let confidence = 35;
  let trendScore = 0;

  if (ema20 > ema50 && adx >= 22) {
    signal = "BUY";
    confidence = 55 + Math.min(25, adx - 20);
    trendScore = 60;
    reasoning.push(`EMA20 > EMA50 with ADX ${adx.toFixed(0)} ≥ 22 — bullish trend confirmed.`);
    if (macd && macd.histogram > 0) {
      confidence += 8;
      reasoning.push("MACD histogram positive — momentum agrees.");
    }
  } else if (ema20 < ema50 && adx >= 22) {
    signal = "SELL";
    confidence = 55 + Math.min(25, adx - 20);
    trendScore = -60;
    reasoning.push(`EMA20 < EMA50 with ADX ${adx.toFixed(0)} ≥ 22 — bearish trend confirmed.`);
    if (macd && macd.histogram < 0) {
      confidence += 8;
      reasoning.push("MACD histogram negative — momentum agrees.");
    }
  } else {
    reasoning.push(
      `EMA stack ${ema20 > ema50 ? "bullish" : "bearish"} but ADX ${adx.toFixed(0)} too weak — wait.`,
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
    strategyId: "ema-cross-adx",
    strategyName: "EMA Cross + ADX",
    category: "trend-following",
    signal: args.signal,
    confidence: Math.round(Math.min(95, Math.max(0, args.confidence))),
    timeframe: "intraday",
    regimeFit: ["Trending Up", "Trending Down", "Breakout"],
    riskLevel: "Medium",
    reasoning: args.reasoning,
    indicatorsUsed: ["EMA20", "EMA50", "ADX14", "MACD"],
    entryConditions: ["EMA20 / EMA50 cross", "ADX ≥ 22"],
    exitConditions: ["EMA20 / EMA50 re-cross", "ADX drops below 18"],
    stopLossLogic: "Opposite EMA (EMA50 for longs).",
    takeProfitLogic: "2× ATR or break of prior swing.",
    volatilityScore: 40,
    momentumScore: args.trendScore * 0.7,
    trendScore: args.trendScore,
  };
}

export const EmaCrossAdx: StrategyDefinition = {
  id: "ema-cross-adx",
  name: "EMA Cross + ADX",
  category: "trend-following",
  description:
    "Short/medium EMA crossover with ADX filter — provides the framework's primary trend-entry voice.",
  timeframes: ["intraday"],
  preferredRegimes: ["Trending Up", "Trending Down", "Breakout"],
  minCandles: 60,
  evaluate,
  enabled: true,
};
