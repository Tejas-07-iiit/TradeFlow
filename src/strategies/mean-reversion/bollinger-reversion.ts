import type { StrategyContext, StrategyDefinition, StrategyOutput } from "@/strategy-core/types";

/**
 * Bollinger Band Mean Reversion.
 *
 * Aligns with Quantpedia's "Mean Reversion Effect in Country Equity Indexes"
 * applied to a single asset: price piercing the outer band tends to revert
 * to the middle band in non-trending regimes.
 *
 * Long when price ≤ lower band AND ADX < 22 (no strong trend).
 * Short when price ≥ upper band AND ADX < 22.
 */
function evaluate(ctx: StrategyContext): StrategyOutput {
  const { bb, adx14, rsi14 } = ctx.indicators;
  const price = ctx.price;
  const reasoning: string[] = [];

  if (!bb) {
    return shell({
      signal: "HOLD",
      confidence: 25,
      reasoning: ["Bollinger bands not yet stable."],
      momentumScore: 0,
    });
  }

  const adx = adx14 ?? 0;
  const rsi = rsi14 ?? 50;
  let signal: StrategyOutput["signal"] = "HOLD";
  let confidence = 35;
  let momentumScore = 0;

  if (price <= bb.lower && adx < 22) {
    signal = "BUY";
    confidence = 55 + Math.min(25, (22 - adx) * 2);
    momentumScore = 40;
    reasoning.push(
      `Price tagged lower band (${bb.lower.toFixed(2)}) with ADX ${adx.toFixed(0)} < 22 — clean revert candidate.`,
    );
    if (rsi < 35) {
      confidence += 5;
      reasoning.push(`RSI ${rsi.toFixed(0)} confirms oversold pressure.`);
    }
  } else if (price >= bb.upper && adx < 22) {
    signal = "SELL";
    confidence = 55 + Math.min(25, (22 - adx) * 2);
    momentumScore = -40;
    reasoning.push(
      `Price tagged upper band (${bb.upper.toFixed(2)}) with ADX ${adx.toFixed(0)} < 22 — clean revert candidate.`,
    );
    if (rsi > 65) {
      confidence += 5;
      reasoning.push(`RSI ${rsi.toFixed(0)} confirms overbought pressure.`);
    }
  } else if (adx >= 22) {
    reasoning.push(`ADX ${adx.toFixed(0)} ≥ 22 — band touches are likely trend continuation, not reversion.`);
  } else {
    reasoning.push("Price within bands — no band-touch setup.");
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
    strategyId: "bollinger-reversion",
    strategyName: "Bollinger Mean Reversion",
    category: "mean-reversion",
    signal: args.signal,
    confidence: Math.round(Math.min(90, Math.max(0, args.confidence))),
    timeframe: "intraday",
    regimeFit: ["Sideways", "Choppy", "Reversal", "Low Volatility"],
    riskLevel: "Medium",
    reasoning: args.reasoning,
    indicatorsUsed: ["Bollinger 20,2", "ADX14", "RSI14"],
    entryConditions: [
      "Price ≤ lower band (long) or ≥ upper band (short)",
      "ADX < 22 — no dominant trend",
    ],
    exitConditions: ["Price reaches Bollinger middle band", "ADX rises above 25"],
    stopLossLogic: "Just outside the touched band.",
    takeProfitLogic: "Bollinger middle band on first touch.",
    volatilityScore: 55,
    momentumScore: args.momentumScore,
    trendScore: -args.momentumScore * 0.4,
  };
}

export const BollingerReversion: StrategyDefinition = {
  id: "bollinger-reversion",
  name: "Bollinger Mean Reversion",
  category: "mean-reversion",
  description:
    "Fades touches of the outer Bollinger band when ADX confirms there is no dominant trend.",
  timeframes: ["intraday", "short-term"],
  preferredRegimes: ["Sideways", "Choppy", "Reversal", "Low Volatility"],
  minCandles: 30,
  evaluate,
  enabled: true,
};
