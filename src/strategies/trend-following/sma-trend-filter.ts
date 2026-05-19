import type { StrategyContext, StrategyDefinition, StrategyOutput } from "@/strategy-core/types";

/**
 * Asset Class Trend-Following — adapted from Mebane Faber's monthly SMA
 * filter to intraday EMA50/EMA200 alignment.
 *
 * The original strategy goes long when price > 10-month SMA and to cash
 * otherwise. Single-asset intraday version: BUY when price > EMA200 AND
 * EMA50 > EMA200; SELL when both flip. Otherwise HOLD.
 *
 * This module exists to give the framework a "structural trend filter"
 * voice — its job is to veto counter-trend ideas, not to drive entries.
 */
function evaluate(ctx: StrategyContext): StrategyOutput {
  const { ema50, ema200, adx14 } = ctx.indicators;
  const price = ctx.price;
  const reasoning: string[] = [];

  if (ema50 == null || ema200 == null) {
    return shell({
      signal: "HOLD",
      confidence: 25,
      reasoning: ["EMA50 or EMA200 not yet stable."],
      trendScore: 0,
    });
  }

  const above200 = price > ema200;
  const stackedUp = ema50 > ema200;
  const stackedDown = ema50 < ema200;
  const adx = adx14 ?? 0;

  let signal: StrategyOutput["signal"] = "HOLD";
  let confidence = 35;
  let trendScore = 0;

  if (above200 && stackedUp) {
    signal = "BUY";
    confidence = 55 + Math.min(30, adx);
    trendScore = 70;
    reasoning.push("Price > EMA200 and EMA50 > EMA200 — structural uptrend in force.");
  } else if (!above200 && stackedDown) {
    signal = "SELL";
    confidence = 55 + Math.min(30, adx);
    trendScore = -70;
    reasoning.push("Price < EMA200 and EMA50 < EMA200 — structural downtrend in force.");
  } else {
    reasoning.push("EMA stack and price disagree — no structural-trend bias.");
  }

  if (signal !== "HOLD" && adx < 18) {
    confidence -= 15;
    reasoning.push(`ADX ${adx.toFixed(0)} below 18 — trend bias is weak.`);
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
    strategyId: "sma-trend-filter",
    strategyName: "SMA Trend Filter",
    category: "trend-following",
    signal: args.signal,
    confidence: Math.round(Math.min(95, Math.max(0, args.confidence))),
    timeframe: "swing",
    regimeFit: ["Trending Up", "Trending Down"],
    riskLevel: "Low",
    reasoning: args.reasoning,
    indicatorsUsed: ["EMA50", "EMA200", "ADX14"],
    entryConditions: ["Price aligned with EMA200", "EMA50 stacked with EMA200"],
    exitConditions: ["EMA50 crosses back through EMA200", "Price closes through EMA200"],
    stopLossLogic: "Below EMA200 for longs (mirror for shorts).",
    takeProfitLogic: "Trail by 2× ATR; ride until structural break.",
    volatilityScore: 30,
    momentumScore: args.trendScore * 0.5,
    trendScore: args.trendScore,
  };
}

export const SmaTrendFilter: StrategyDefinition = {
  id: "sma-trend-filter",
  name: "SMA Trend Filter",
  category: "trend-following",
  description:
    "Faber-style structural trend filter using EMA50 / EMA200 — provides a directional veto for the rest of the suite.",
  timeframes: ["swing", "intraday"],
  preferredRegimes: ["Trending Up", "Trending Down"],
  minCandles: 200,
  evaluate,
  enabled: true,
};
