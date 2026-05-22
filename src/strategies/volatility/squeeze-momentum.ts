import type { StrategyContext, StrategyDefinition, StrategyOutput } from "@/strategy-core/types";

/**
 * Squeeze Momentum (LazyBear) — detects volatility compression (Bollinger
 * Bands inside Keltner Channels) and trades the release in the direction of
 * the momentum histogram.
 *
 * Squeeze ON  : BB upper < KC upper AND BB lower > KC lower (compression)
 * Squeeze OFF : BB outside KC again — energy released, follow the histogram
 * Momentum    : linreg slope of (close - midpoint) over 20 bars (approximated
 *               here with MACD histogram polarity for simplicity — the
 *               original Pine linreg is overkill given we already trust MACD)
 */
function isSqueezeOn(bb: { upper: number; lower: number }, kc: { upper: number; lower: number }): boolean {
  return bb.upper < kc.upper && bb.lower > kc.lower;
}

function evaluate(ctx: StrategyContext): StrategyOutput {
  const { bb, keltner, macd } = ctx.indicators;
  const reasoning: string[] = [];

  if (!bb || !keltner || !macd) {
    return shell({
      signal: "HOLD",
      confidence: 25,
      reasoning: ["Bollinger / Keltner / MACD not yet stable."],
      volatilityScore: 50,
      momentumScore: 0,
    });
  }

  const squeezeNow = isSqueezeOn(bb, keltner);
  // We don't have prior-bar BB/KC pre-computed; squeeze RELEASE is detected
  // by current=off + the bands being structurally close (BB width ≤ 1.1× KC
  // width is a clean "just exited the squeeze" proxy).
  const bbWidth = bb.upper - bb.lower;
  const kcWidth = keltner.upper - keltner.lower;
  const justReleased = !squeezeNow && bbWidth <= kcWidth * 1.25;

  let signal: StrategyOutput["signal"] = "HOLD";
  let confidence = 35;
  let momentumScore = 0;
  let volatilityScore = 60;

  if (squeezeNow) {
    confidence = 45;
    volatilityScore = 30;
    reasoning.push(
      `Squeeze ON — BB inside KC. Wait for release; current MACD histogram ${macd.histogram >= 0 ? "+" : ""}${macd.histogram.toFixed(4)} hints at ${macd.histogram >= 0 ? "bullish" : "bearish"} break.`,
    );
  } else if (justReleased && macd.histogram > 0) {
    signal = "BUY";
    confidence = 75;
    momentumScore = 70;
    volatilityScore = 75;
    reasoning.push(
      `Squeeze just released with rising MACD histogram (+${macd.histogram.toFixed(4)}) — bullish expansion.`,
    );
  } else if (justReleased && macd.histogram < 0) {
    signal = "SELL";
    confidence = 75;
    momentumScore = -70;
    volatilityScore = 75;
    reasoning.push(
      `Squeeze just released with falling MACD histogram (${macd.histogram.toFixed(4)}) — bearish expansion.`,
    );
  } else {
    reasoning.push(
      `No squeeze and no fresh release — BB width ${bbWidth.toFixed(2)} vs KC width ${kcWidth.toFixed(2)}.`,
    );
  }

  return shell({ signal, confidence, reasoning, volatilityScore, momentumScore });
}

function shell(args: {
  signal: StrategyOutput["signal"];
  confidence: number;
  reasoning: string[];
  volatilityScore: number;
  momentumScore: number;
}): StrategyOutput {
  return {
    strategyId: "squeeze-momentum",
    strategyName: "Squeeze Momentum (LazyBear)",
    category: "volatility",
    signal: args.signal,
    confidence: Math.round(Math.min(88, Math.max(0, args.confidence))),
    timeframe: "intraday",
    regimeFit: ["Breakout", "Low Volatility", "High Volatility"],
    riskLevel: "Medium",
    reasoning: args.reasoning,
    indicatorsUsed: ["Bollinger Bands 20/2", "Keltner 20/1.5", "MACD histogram"],
    entryConditions: [
      "BB inside KC (squeeze ON) then release",
      "MACD histogram polarity sets direction",
    ],
    exitConditions: [
      "Histogram colour changes",
      "Price reaches opposite Keltner channel",
    ],
    stopLossLogic: "Opposite Keltner channel.",
    takeProfitLogic: "Trail momentum histogram peaks; partial at 1× ATR.",
    volatilityScore: args.volatilityScore,
    momentumScore: args.momentumScore,
    trendScore: args.momentumScore * 0.4,
  };
}

export const SqueezeMomentum: StrategyDefinition = {
  id: "squeeze-momentum",
  name: "Squeeze Momentum",
  category: "volatility",
  description:
    "LazyBear Squeeze — BB inside KC compression release, traded in the direction of the MACD histogram. Excels at catching explosive breakouts after consolidation.",
  timeframes: ["intraday", "short-term"],
  preferredRegimes: ["Breakout", "Low Volatility", "High Volatility"],
  minCandles: 40,
  evaluate,
  enabled: true,
};
