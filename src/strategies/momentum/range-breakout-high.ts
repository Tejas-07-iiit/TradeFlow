import type { StrategyContext, StrategyDefinition, StrategyOutput } from "@/strategy-core/types";

/**
 * 52-Week High Effect (George & Hwang 2004) — adapted.
 *
 * Quantpedia anomaly: stocks near their 52-week high outperform; stocks near
 * their 52-week low underperform. We adapt by using the 52-period high/low
 * on the active timeframe (so on 5m bars, ~4.3 hours of range).
 *
 * Long when price > 99% of 52-period high.
 * Short when price < 101% of 52-period low.
 */
function evaluate(ctx: StrategyContext): StrategyOutput {
  const { rangeHigh52, rangeLow52, adx14 } = ctx.indicators;
  const price = ctx.price;
  const reasoning: string[] = [];

  if (rangeHigh52 == null || rangeLow52 == null) {
    return shell({
      signal: "HOLD",
      confidence: 25,
      reasoning: ["Insufficient bars to compute 52-period range."],
      momentumScore: 0,
    });
  }

  const proximityHigh = price / rangeHigh52;
  const proximityLow = price / rangeLow52;

  let signal: StrategyOutput["signal"] = "HOLD";
  let confidence = 35;
  let momentumScore = 0;

  if (proximityHigh >= 0.995) {
    signal = "BUY";
    momentumScore = 80;
    confidence = 60 + Math.min(20, (adx14 ?? 0) - 15);
    reasoning.push(
      `Price ${formatPct(proximityHigh - 1)} from 52-bar high — high-proximity continuation setup.`,
    );
  } else if (proximityLow <= 1.005) {
    signal = "SELL";
    momentumScore = -80;
    confidence = 60 + Math.min(20, (adx14 ?? 0) - 15);
    reasoning.push(
      `Price ${formatPct(proximityLow - 1)} from 52-bar low — low-proximity breakdown setup.`,
    );
  } else {
    reasoning.push("Price sitting mid-range; no 52-bar extreme.");
  }

  if (adx14 != null && adx14 < 18 && signal !== "HOLD") {
    confidence -= 12;
    reasoning.push("ADX < 18 — penalising signal: range may fail.");
  }

  return shell({ signal, confidence, reasoning, momentumScore });
}

function formatPct(v: number): string {
  return `${(v * 100).toFixed(2)}%`;
}

function shell(args: {
  signal: StrategyOutput["signal"];
  confidence: number;
  reasoning: string[];
  momentumScore: number;
}): StrategyOutput {
  const c = Math.round(Math.min(95, Math.max(0, args.confidence)));
  return {
    strategyId: "range-breakout-high",
    strategyName: "52-Bar High/Low Effect",
    category: "momentum",
    signal: args.signal,
    confidence: c,
    timeframe: "intraday",
    regimeFit: ["Trending Up", "Trending Down", "Breakout"],
    riskLevel: "Medium",
    reasoning: args.reasoning,
    indicatorsUsed: ["52-period high", "52-period low", "ADX14"],
    entryConditions: [
      "Price within 0.5% of 52-bar high (long) or low (short)",
      "ADX ≥ 18 confirms directional intent",
    ],
    exitConditions: [
      "Price re-enters middle of 52-bar range",
      "ADX drops below 15",
    ],
    stopLossLogic: "Just inside the prior range boundary (1× ATR cushion).",
    takeProfitLogic: "1.5× ATR extension beyond the broken level.",
    volatilityScore: 55,
    momentumScore: args.momentumScore,
    trendScore: args.momentumScore * 0.8,
  };
}

export const RangeBreakoutHigh: StrategyDefinition = {
  id: "range-breakout-high",
  name: "52-Bar High/Low Effect",
  category: "momentum",
  description:
    "Adaptation of Quantpedia's 52-Week High effect: trade continuation when price sits at the extreme of its 52-bar range.",
  timeframes: ["intraday", "short-term"],
  preferredRegimes: ["Trending Up", "Trending Down", "Breakout"],
  minCandles: 60,
  evaluate,
  enabled: true,
};
