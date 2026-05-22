import type { StrategyContext, StrategyDefinition, StrategyOutput } from "@/strategy-core/types";

/**
 * Ichimoku Cloud — full Japanese trend/momentum/SR system.
 *
 * BUY  : price > cloud (max(senkouA, senkouB)) AND tenkan > kijun AND
 *        chikou > price-26-bars-ago.
 * SELL : price < cloud AND tenkan < kijun AND chikou < price-26-bars-ago.
 *
 * The Chikou confirmation requires 26 bars of look-ahead, so we use the
 * `chikou` field returned by the indicator (price 26 bars in the future) —
 * for the *current* bar that is null. We fall back to the most recent fully
 * confirmed bar (26 bars back) for the Chikou check, which mirrors how
 * traders use the indicator in practice.
 */
function evaluate(ctx: StrategyContext): StrategyOutput {
  const { ichimoku } = ctx.indicators;
  const reasoning: string[] = [];

  if (!ichimoku) {
    return shell({
      signal: "HOLD",
      confidence: 25,
      reasoning: ["Ichimoku not yet stable (needs ≥52 bars)."],
      trendScore: 0,
    });
  }

  const price = ctx.price;
  const { tenkan, kijun, senkouA, senkouB } = ichimoku;
  const cloudTop = Math.max(senkouA, senkouB);
  const cloudBottom = Math.min(senkouA, senkouB);

  // Chikou confirmation: compare the close 26 bars ago vs the close 52 bars ago.
  const closes = ctx.candles.map((c) => c.close);
  const chikouBull =
    closes.length >= 53 && closes[closes.length - 27] > closes[closes.length - 53];
  const chikouBear =
    closes.length >= 53 && closes[closes.length - 27] < closes[closes.length - 53];

  let signal: StrategyOutput["signal"] = "HOLD";
  let confidence = 35;
  let trendScore = 0;

  if (price > cloudTop && tenkan > kijun && chikouBull) {
    signal = "BUY";
    confidence = 78;
    trendScore = 75;
    reasoning.push(
      `Price ${price.toFixed(2)} above cloud (${cloudTop.toFixed(2)}), Tenkan ${tenkan.toFixed(2)} > Kijun ${kijun.toFixed(2)}, Chikou confirms bullish.`,
    );
  } else if (price < cloudBottom && tenkan < kijun && chikouBear) {
    signal = "SELL";
    confidence = 78;
    trendScore = -75;
    reasoning.push(
      `Price ${price.toFixed(2)} below cloud (${cloudBottom.toFixed(2)}), Tenkan ${tenkan.toFixed(2)} < Kijun ${kijun.toFixed(2)}, Chikou confirms bearish.`,
    );
  } else if (price > cloudBottom && price < cloudTop) {
    reasoning.push(
      `Price inside cloud (${cloudBottom.toFixed(2)} – ${cloudTop.toFixed(2)}) — Ichimoku neutral.`,
    );
  } else {
    reasoning.push(
      `Trend partially aligned (TK ${tenkan > kijun ? "bull" : "bear"}, Chikou ${chikouBull ? "bull" : chikouBear ? "bear" : "flat"}) — waiting for full confluence.`,
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
    strategyId: "ichimoku-cloud",
    strategyName: "Ichimoku Cloud",
    category: "trend-following",
    signal: args.signal,
    confidence: Math.round(Math.min(90, Math.max(0, args.confidence))),
    timeframe: "swing",
    regimeFit: ["Trending Up", "Trending Down"],
    riskLevel: "Low",
    reasoning: args.reasoning,
    indicatorsUsed: ["Tenkan-Sen", "Kijun-Sen", "Senkou A/B", "Chikou Span"],
    entryConditions: [
      "Price above/below cloud",
      "Tenkan-Sen crosses Kijun-Sen in trend direction",
      "Chikou Span confirms trend direction",
    ],
    exitConditions: [
      "Tenkan crosses Kijun opposite",
      "Price closes back inside the cloud",
    ],
    stopLossLogic: "Far side of the cloud or Kijun line.",
    takeProfitLogic: "Trail Kijun-Sen until TK cross or cloud entry.",
    volatilityScore: 45,
    momentumScore: args.trendScore * 0.7,
    trendScore: args.trendScore,
  };
}

export const IchimokuCloud: StrategyDefinition = {
  id: "ichimoku-cloud",
  name: "Ichimoku Cloud",
  category: "trend-following",
  description:
    "Full Ichimoku confluence — price vs cloud + TK cross + Chikou Span confirmation. Filters out the vast majority of low-quality trend signals.",
  timeframes: ["swing", "position"],
  preferredRegimes: ["Trending Up", "Trending Down"],
  minCandles: 60,
  evaluate,
  enabled: true,
};
