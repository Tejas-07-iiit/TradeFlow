import type { StrategyContext, StrategyDefinition, StrategyOutput } from "@/strategy-core/types";

/**
 * Parabolic RSI — applies Parabolic SAR logic directly to the RSI series so
 * momentum shifts surface earlier than price-based reversal triggers. The
 * 200 EMA gates the trade direction to the macro trend; without that filter
 * the signal whipsaws in chop.
 *
 * Long  → RSI crosses above its own PSAR AND price > 200 EMA.
 * Short → RSI crosses below its own PSAR AND price < 200 EMA.
 */
function evaluate(ctx: StrategyContext): StrategyOutput {
  const { psarOnRsi, ema200, rsi14 } = ctx.indicators;
  const reasoning: string[] = [];

  if (!psarOnRsi || ema200 == null) {
    return shell({
      signal: "HOLD",
      confidence: 25,
      reasoning: ["PSAR-on-RSI or EMA200 not yet stable."],
      momentumScore: 0,
    });
  }

  const price = ctx.price;
  const rsi = rsi14 ?? psarOnRsi.rsi;
  const aboveSar = rsi > psarOnRsi.value;
  const aboveEma = price > ema200;

  let signal: StrategyOutput["signal"] = "HOLD";
  let confidence = 35;
  let momentumScore = 0;

  if (aboveSar && aboveEma && psarOnRsi.trend === 1) {
    signal = "BUY";
    confidence = 60 + Math.min(20, Math.max(0, rsi - 50));
    momentumScore = 65;
    reasoning.push(
      `RSI ${rsi.toFixed(1)} above its PSAR ${psarOnRsi.value.toFixed(1)} (long trend) with price ${price.toFixed(2)} > EMA200 ${ema200.toFixed(2)}.`,
    );
  } else if (!aboveSar && !aboveEma && psarOnRsi.trend === -1) {
    signal = "SELL";
    confidence = 60 + Math.min(20, Math.max(0, 50 - rsi));
    momentumScore = -65;
    reasoning.push(
      `RSI ${rsi.toFixed(1)} below its PSAR ${psarOnRsi.value.toFixed(1)} (short trend) with price ${price.toFixed(2)} < EMA200 ${ema200.toFixed(2)}.`,
    );
  } else if (aboveSar !== aboveEma) {
    reasoning.push(
      `RSI/PSAR ${aboveSar ? "bullish" : "bearish"} but EMA200 macro disagrees — wait for alignment.`,
    );
  } else {
    reasoning.push("No fresh RSI/PSAR cross — momentum unchanged.");
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
    strategyId: "parabolic-rsi",
    strategyName: "Parabolic RSI",
    category: "momentum",
    signal: args.signal,
    confidence: Math.round(Math.min(92, Math.max(0, args.confidence))),
    timeframe: "intraday",
    regimeFit: ["Trending Up", "Trending Down", "Reversal", "Breakout"],
    riskLevel: "Medium",
    reasoning: args.reasoning,
    indicatorsUsed: ["RSI14", "Parabolic SAR (on RSI)", "EMA200"],
    entryConditions: [
      "RSI crosses its own PSAR in the macro-trend direction",
      "Price aligned with 200 EMA",
    ],
    exitConditions: [
      "Opposite RSI/PSAR cross",
      "Price closing on the wrong side of 200 EMA",
    ],
    stopLossLogic: "Recent swing high/low or 1.5× ATR — whichever is closer.",
    takeProfitLogic: "Trail the PSAR-on-RSI dots; partial at 1× ATR.",
    volatilityScore: 55,
    momentumScore: args.momentumScore,
    trendScore: args.momentumScore * 0.6,
  };
}

export const ParabolicRsi: StrategyDefinition = {
  id: "parabolic-rsi",
  name: "Parabolic RSI",
  category: "momentum",
  description:
    "ChartPrime-style PSAR applied to the RSI series — surfaces momentum reversals earlier than price-based PSAR, filtered by the 200 EMA macro trend.",
  timeframes: ["intraday", "short-term"],
  preferredRegimes: ["Trending Up", "Trending Down", "Reversal", "Breakout"],
  minCandles: 60,
  evaluate,
  enabled: true,
};
