import { heikenAshi } from "@/lib/indicators/calculations";
import type { StrategyContext, StrategyDefinition, StrategyOutput } from "@/strategy-core/types";

/**
 * Swing Surfing on Slow Heiken Ashi — convert candles to Heiken Ashi and
 * trade fresh colour flips with the 200 EMA macro filter.
 *
 * "Slow" Heiken Ashi here means the standard HA conversion but we require
 * the colour flip to be sustained for two consecutive bars before signalling,
 * which smooths the inherent noise of HA on lower timeframes.
 */
function colour(ha: { open: number; close: number }): 1 | -1 | 0 {
  if (ha.close > ha.open) return 1;
  if (ha.close < ha.open) return -1;
  return 0;
}

function evaluate(ctx: StrategyContext): StrategyOutput {
  const { ema200 } = ctx.indicators;
  const reasoning: string[] = [];

  if (ctx.candles.length < 30 || ema200 == null) {
    return shell({
      signal: "HOLD",
      confidence: 25,
      reasoning: ["Need ≥30 bars and EMA200 to evaluate."],
      trendScore: 0,
    });
  }

  const ha = heikenAshi(ctx.candles);
  if (ha.length < 3) {
    return shell({
      signal: "HOLD",
      confidence: 25,
      reasoning: ["HA series too short."],
      trendScore: 0,
    });
  }

  const last = ha.at(-1)!;
  const prev = ha.at(-2)!;
  const prev2 = ha.at(-3)!;
  const cNow = colour(last);
  const cPrev = colour(prev);
  const cPrev2 = colour(prev2);

  const flipUp = cNow === 1 && cPrev === 1 && cPrev2 === -1;
  const flipDown = cNow === -1 && cPrev === -1 && cPrev2 === 1;

  let signal: StrategyOutput["signal"] = "HOLD";
  let confidence = 35;
  let trendScore = 0;
  const price = ctx.price;

  if (flipUp && price > ema200) {
    signal = "BUY";
    confidence = 72;
    trendScore = 65;
    reasoning.push(
      `HA flipped red→green 2 bars ago and held; price ${price.toFixed(2)} > EMA200 ${ema200.toFixed(2)}.`,
    );
  } else if (flipDown && price < ema200) {
    signal = "SELL";
    confidence = 72;
    trendScore = -65;
    reasoning.push(
      `HA flipped green→red 2 bars ago and held; price ${price.toFixed(2)} < EMA200 ${ema200.toFixed(2)}.`,
    );
  } else if (cNow === 1 && cPrev === 1 && price > ema200) {
    signal = "BUY";
    confidence = 50;
    trendScore = 40;
    reasoning.push("Persistent green HA stack with bullish macro — momentum continuation.");
  } else if (cNow === -1 && cPrev === -1 && price < ema200) {
    signal = "SELL";
    confidence = 50;
    trendScore = -40;
    reasoning.push("Persistent red HA stack with bearish macro — momentum continuation.");
  } else {
    reasoning.push(
      `No 2-bar HA confirmation (cur=${cNow} prev=${cPrev}); macro ${price > ema200 ? "bull" : "bear"}.`,
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
    strategyId: "heiken-ashi-swing",
    strategyName: "Slow Heiken Ashi Swing",
    category: "trend-following",
    signal: args.signal,
    confidence: Math.round(Math.min(85, Math.max(0, args.confidence))),
    timeframe: "swing",
    regimeFit: ["Trending Up", "Trending Down"],
    riskLevel: "Medium",
    reasoning: args.reasoning,
    indicatorsUsed: ["Heiken Ashi candles", "EMA200"],
    entryConditions: [
      "HA colour flips and holds for 2 bars",
      "Macro EMA200 aligned with flip direction",
    ],
    exitConditions: ["First opposing HA colour bar"],
    stopLossLogic: "Low of the flip bar (longs) / high (shorts).",
    takeProfitLogic: "Trail bar-by-bar until HA flip closes.",
    volatilityScore: 45,
    momentumScore: args.trendScore * 0.6,
    trendScore: args.trendScore,
  };
}

export const HeikenAshiSwing: StrategyDefinition = {
  id: "heiken-ashi-swing",
  name: "Slow Heiken Ashi Swing",
  category: "trend-following",
  description:
    "Heiken Ashi colour-flip swing trader — requires a 2-bar confirmation and EMA200 macro alignment to filter HA's chronic whipsaws.",
  timeframes: ["swing", "short-term"],
  preferredRegimes: ["Trending Up", "Trending Down"],
  minCandles: 30,
  evaluate,
  enabled: true,
};
