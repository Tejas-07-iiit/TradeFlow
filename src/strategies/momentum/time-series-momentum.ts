import type { StrategyContext, StrategyDefinition, StrategyOutput } from "@/strategy-core/types";

/**
 * Time-Series Momentum (Moskowitz, Ooi, Pedersen 2012).
 *
 * Quantpedia anomaly: "Time Series Momentum Effect" — assets that have gone
 * up over the recent past tend to continue going up; those that have gone
 * down continue down. We adapt the monthly equity formulation to a 12-bar
 * lookback on the active intraday timeframe.
 *
 * Long when 12-bar return > +0.4% AND closing above EMA50.
 * Short when 12-bar return < -0.4% AND closing below EMA50.
 */
function evaluate(ctx: StrategyContext): StrategyOutput {
  const { momentum12, ema50 } = ctx.indicators;
  const price = ctx.price;
  const reasoning: string[] = [];

  let signal: StrategyOutput["signal"] = "HOLD";
  let confidence = 35;
  let momentumScore = 0;
  let trendScore = 0;

  if (momentum12 == null || ema50 == null) {
    return baseOutput({
      signal: "HOLD",
      confidence: 25,
      reasoning: ["Insufficient history for 12-bar momentum reading."],
      momentumScore: 0,
      trendScore: 0,
    });
  }

  const mom = momentum12 * 100;
  momentumScore = clamp(mom * 10, -100, 100);
  trendScore = price > ema50 ? 35 : -35;

  if (mom > 0.4 && price > ema50) {
    signal = "BUY";
    confidence = 55 + Math.min(35, Math.abs(mom) * 8);
    reasoning.push(`12-bar return +${mom.toFixed(2)}% with price above EMA50.`);
    reasoning.push("Time-series momentum aligned long — continuation favoured.");
  } else if (mom < -0.4 && price < ema50) {
    signal = "SELL";
    confidence = 55 + Math.min(35, Math.abs(mom) * 8);
    reasoning.push(`12-bar return ${mom.toFixed(2)}% with price below EMA50.`);
    reasoning.push("Time-series momentum aligned short — continuation favoured.");
  } else {
    reasoning.push(`Momentum (${mom.toFixed(2)}%) and EMA50 disagree — no continuation edge.`);
  }

  return baseOutput({ signal, confidence, reasoning, momentumScore, trendScore });
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function baseOutput(args: {
  signal: StrategyOutput["signal"];
  confidence: number;
  reasoning: string[];
  momentumScore: number;
  trendScore: number;
}): StrategyOutput {
  return {
    strategyId: "time-series-momentum",
    strategyName: "Time-Series Momentum",
    category: "momentum",
    signal: args.signal,
    confidence: Math.round(clamp(args.confidence, 0, 95)),
    timeframe: "intraday",
    regimeFit: ["Trending Up", "Trending Down", "Breakout"],
    riskLevel: "Medium",
    reasoning: args.reasoning,
    indicatorsUsed: ["12-bar return", "EMA50"],
    entryConditions: [
      "12-bar return magnitude > 0.4%",
      "Price aligned with EMA50",
    ],
    exitConditions: [
      "Momentum decays toward zero",
      "Price closes back across EMA50",
    ],
    stopLossLogic: "1.5× ATR below entry for longs (mirrored for shorts).",
    takeProfitLogic: "Trail by 1× ATR once trade moves 1.5× ATR in favour.",
    volatilityScore: 50,
    momentumScore: args.momentumScore,
    trendScore: args.trendScore,
  };
}

export const TimeSeriesMomentum: StrategyDefinition = {
  id: "time-series-momentum",
  name: "Time-Series Momentum",
  category: "momentum",
  description:
    "Continuation-style intraday momentum; longs when the recent return and trend filter agree, shorts when both flip.",
  timeframes: ["intraday", "short-term"],
  preferredRegimes: ["Trending Up", "Trending Down", "Breakout"],
  minCandles: 60,
  evaluate,
  enabled: true,
};
