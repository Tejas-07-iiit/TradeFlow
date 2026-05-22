import type { StrategyContext, StrategyDefinition, StrategyOutput } from "@/strategy-core/types";

/**
 * Bollinger Bands Breakout — the *opposite* directional bias from the
 * existing BollingerReversion strategy. Reversion fades band touches in
 * sideways tape; this strategy buys closes above the upper band and sells
 * closes below the lower band, gated by ADX ≥ 22 to ensure we only trade
 * with-the-trend breakouts.
 */
function evaluate(ctx: StrategyContext): StrategyOutput {
  const { bb, adx14, atr14 } = ctx.indicators;
  const reasoning: string[] = [];

  if (!bb) {
    return shell({
      signal: "HOLD",
      confidence: 25,
      reasoning: ["Bollinger bands not yet stable."],
      momentumScore: 0,
    });
  }

  const price = ctx.price;
  const adx = adx14 ?? 0;
  let signal: StrategyOutput["signal"] = "HOLD";
  let confidence = 35;
  let momentumScore = 0;

  if (price > bb.upper && adx >= 22) {
    signal = "BUY";
    const extension = ((price - bb.upper) / Math.max(0.0001, atr14 ?? bb.upper)) * 20;
    confidence = 60 + Math.min(25, Math.max(0, adx - 22)) + Math.min(10, extension);
    momentumScore = 75;
    reasoning.push(
      `Close ${price.toFixed(2)} above upper band ${bb.upper.toFixed(2)} with ADX ${adx.toFixed(0)} ≥ 22 — trend breakout.`,
    );
  } else if (price < bb.lower && adx >= 22) {
    signal = "SELL";
    const extension = ((bb.lower - price) / Math.max(0.0001, atr14 ?? bb.lower)) * 20;
    confidence = 60 + Math.min(25, Math.max(0, adx - 22)) + Math.min(10, extension);
    momentumScore = -75;
    reasoning.push(
      `Close ${price.toFixed(2)} below lower band ${bb.lower.toFixed(2)} with ADX ${adx.toFixed(0)} ≥ 22 — trend breakdown.`,
    );
  } else if (adx < 22) {
    reasoning.push(
      `ADX ${adx.toFixed(0)} < 22 — band touches are revert candidates, not breakouts (defer to Bollinger Reversion).`,
    );
  } else {
    reasoning.push("Price within bands — nothing to trade.");
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
    strategyId: "bollinger-breakout",
    strategyName: "Bollinger Bands Breakout",
    category: "breakout",
    signal: args.signal,
    confidence: Math.round(Math.min(90, Math.max(0, args.confidence))),
    timeframe: "intraday",
    regimeFit: ["Breakout", "Trending Up", "Trending Down", "High Volatility"],
    riskLevel: "High",
    reasoning: args.reasoning,
    indicatorsUsed: ["Bollinger 20/2", "ADX14", "ATR14"],
    entryConditions: [
      "Price closes above upper Bollinger (long) or below lower Bollinger (short)",
      "ADX ≥ 22 — trend confirmation",
    ],
    exitConditions: [
      "Price touches middle band",
      "ADX drops below 18",
    ],
    stopLossLogic: "Middle band or 1.5× ATR inside the breakout level.",
    takeProfitLogic: "Opposite band on continuation; fixed R:R 1:2 otherwise.",
    volatilityScore: 70,
    momentumScore: args.momentumScore,
    trendScore: args.momentumScore * 0.6,
  };
}

export const BollingerBreakout: StrategyDefinition = {
  id: "bollinger-breakout",
  name: "Bollinger Bands Breakout",
  category: "breakout",
  description:
    "Trades continuation closes outside the Bollinger envelope when ADX confirms a trend regime — the institutional counterpart to the Bollinger Reversion fade.",
  timeframes: ["intraday", "short-term"],
  preferredRegimes: ["Breakout", "Trending Up", "Trending Down", "High Volatility"],
  minCandles: 25,
  evaluate,
  enabled: true,
};
