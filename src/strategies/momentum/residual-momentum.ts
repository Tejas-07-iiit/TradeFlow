import type { StrategyContext, StrategyDefinition, StrategyOutput } from "@/strategy-core/types";

/**
 * Residual Momentum (Blitz, Huij, Martens 2011) — adapted.
 *
 * The classical factor strips market beta off returns and ranks on the
 * residual. On a single-asset intraday tape we don't have a cross-section,
 * so we approximate the "residual" by measuring how much the recent move
 * disagrees with the longer-term EMA200 baseline.
 *
 * In other words: a stretched 12-bar move that's also pulled away from
 * EMA200 is "abnormal momentum" — the kind that historically continues.
 */
function evaluate(ctx: StrategyContext): StrategyOutput {
  const { momentum12, ema200, rsi14 } = ctx.indicators;
  const price = ctx.price;
  const reasoning: string[] = [];

  if (momentum12 == null || ema200 == null) {
    return shell({
      signal: "HOLD",
      confidence: 25,
      reasoning: ["Missing EMA200 or 12-bar momentum baseline."],
      score: 0,
    });
  }

  const distFromBaseline = (price - ema200) / ema200;
  const residual = momentum12 - distFromBaseline * 0.2;
  const r = residual * 100;

  let signal: StrategyOutput["signal"] = "HOLD";
  let confidence = 35;

  if (r > 0.5 && (rsi14 ?? 50) > 50) {
    signal = "BUY";
    confidence = 55 + Math.min(30, Math.abs(r) * 6);
    reasoning.push(
      `Residual momentum +${r.toFixed(2)}% with RSI ${rsi14?.toFixed(0)} > 50.`,
    );
  } else if (r < -0.5 && (rsi14 ?? 50) < 50) {
    signal = "SELL";
    confidence = 55 + Math.min(30, Math.abs(r) * 6);
    reasoning.push(
      `Residual momentum ${r.toFixed(2)}% with RSI ${rsi14?.toFixed(0)} < 50.`,
    );
  } else {
    reasoning.push(`Residual reading ${r.toFixed(2)}% — no abnormal-momentum edge.`);
  }

  return shell({ signal, confidence, reasoning, score: r * 10 });
}

function shell(args: {
  signal: StrategyOutput["signal"];
  confidence: number;
  reasoning: string[];
  score: number;
}): StrategyOutput {
  const clamped = Math.max(-100, Math.min(100, args.score));
  return {
    strategyId: "residual-momentum",
    strategyName: "Residual Momentum",
    category: "momentum",
    signal: args.signal,
    confidence: Math.round(Math.min(95, Math.max(0, args.confidence))),
    timeframe: "intraday",
    regimeFit: ["Trending Up", "Trending Down"],
    riskLevel: "Medium",
    reasoning: args.reasoning,
    indicatorsUsed: ["12-bar momentum", "EMA200 baseline", "RSI14"],
    entryConditions: [
      "Residual momentum magnitude > 0.5%",
      "RSI confirms direction of residual",
    ],
    exitConditions: [
      "Residual collapses toward zero",
      "RSI crosses 50 against the trade",
    ],
    stopLossLogic: "1.2× ATR against entry.",
    takeProfitLogic: "Exit when residual momentum reverts past zero.",
    volatilityScore: 50,
    momentumScore: clamped,
    trendScore: clamped * 0.6,
  };
}

export const ResidualMomentum: StrategyDefinition = {
  id: "residual-momentum",
  name: "Residual Momentum",
  category: "momentum",
  description:
    "Approximates the residual-momentum factor by removing EMA200 baseline drift from recent return.",
  timeframes: ["intraday", "short-term"],
  preferredRegimes: ["Trending Up", "Trending Down"],
  minCandles: 200,
  evaluate,
  enabled: true,
};
