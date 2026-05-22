import { lastNumber, t3 } from "@/lib/indicators/calculations";
import type { StrategyContext, StrategyDefinition, StrategyOutput } from "@/strategy-core/types";

/**
 * T3 Nexus — Tillson T3 turn-direction + price-cross trend follower.
 *
 * Long  → T3 turns up *and* price > T3.
 * Short → T3 turns down *and* price < T3.
 *
 * The pre-computed T3 in IndicatorContext gives us the current value; we
 * recompute the previous bar locally (a single extra T3 pass) to detect the
 * turn.
 */
function evaluate(ctx: StrategyContext): StrategyOutput {
  const reasoning: string[] = [];
  const closes = ctx.candles.map((c) => c.close);
  if (closes.length < 30) {
    return shell({
      signal: "HOLD",
      confidence: 25,
      reasoning: ["Need ≥30 bars."],
      trendScore: 0,
    });
  }

  const t3Series = t3(closes, 8, 0.7);
  const t3Now = lastNumber(t3Series);
  const t3Prev = t3Series.at(-2) ?? null;
  if (t3Now == null || t3Prev == null) {
    return shell({
      signal: "HOLD",
      confidence: 25,
      reasoning: ["T3 series not yet stable."],
      trendScore: 0,
    });
  }

  const slope = t3Now - t3Prev;
  const price = ctx.price;
  let signal: StrategyOutput["signal"] = "HOLD";
  let confidence = 35;
  let trendScore = 0;

  if (slope > 0 && price > t3Now) {
    signal = "BUY";
    confidence = 68 + Math.min(15, Math.abs((slope / t3Now) * 10000));
    trendScore = 60;
    reasoning.push(
      `T3 turning up (Δ ${slope.toFixed(4)}) with price ${price.toFixed(2)} > T3 ${t3Now.toFixed(2)}.`,
    );
  } else if (slope < 0 && price < t3Now) {
    signal = "SELL";
    confidence = 68 + Math.min(15, Math.abs((slope / t3Now) * 10000));
    trendScore = -60;
    reasoning.push(
      `T3 turning down (Δ ${slope.toFixed(4)}) with price ${price.toFixed(2)} < T3 ${t3Now.toFixed(2)}.`,
    );
  } else {
    reasoning.push(
      `T3 slope ${slope >= 0 ? "+" : ""}${slope.toFixed(4)} but price ${price.toFixed(2)} disagrees with T3 ${t3Now.toFixed(2)}.`,
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
    strategyId: "t3-nexus",
    strategyName: "T3 Nexus Plus",
    category: "trend-following",
    signal: args.signal,
    confidence: Math.round(Math.min(85, Math.max(0, args.confidence))),
    timeframe: "intraday",
    regimeFit: ["Trending Up", "Trending Down", "Breakout"],
    riskLevel: "Medium",
    reasoning: args.reasoning,
    indicatorsUsed: ["Tillson T3 (length=8, b=0.7)"],
    entryConditions: [
      "T3 turns up & price > T3 (long)",
      "T3 turns down & price < T3 (short)",
    ],
    exitConditions: ["T3 turns opposite", "Price crosses back through T3"],
    stopLossLogic: "Just below/above T3 line.",
    takeProfitLogic: "Trail T3 line.",
    volatilityScore: 40,
    momentumScore: args.trendScore * 0.6,
    trendScore: args.trendScore,
  };
}

export const T3Nexus: StrategyDefinition = {
  id: "t3-nexus",
  name: "T3 Nexus Plus",
  category: "trend-following",
  description:
    "Tillson T3 (8, 0.7) turn-direction trend follower — extremely smooth with minimal lag thanks to the triple-EMA chain.",
  timeframes: ["intraday", "short-term"],
  preferredRegimes: ["Trending Up", "Trending Down", "Breakout"],
  minCandles: 30,
  evaluate,
  enabled: true,
};
