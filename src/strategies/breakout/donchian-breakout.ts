import type { StrategyContext, StrategyDefinition, StrategyOutput } from "@/strategy-core/types";

/**
 * Donchian breakout — the original "Turtle" entry.
 *
 * BUY when the close exceeds the 20-bar Donchian high.
 * SELL when the close prints below the 20-bar Donchian low.
 *
 * The 52-bar high/low strategy is a longer-cycle version of the same idea;
 * Donchian focuses on the recent regime and produces signals more often.
 */
function evaluate(ctx: StrategyContext): StrategyOutput {
  const reasoning: string[] = [];
  const { candles } = ctx;
  if (candles.length < 25) {
    return shell({
      signal: "HOLD",
      confidence: 25,
      reasoning: ["Insufficient bars for 20-bar Donchian channel."],
      momentumScore: 0,
    });
  }

  const window = candles.slice(-21, -1);
  const high = Math.max(...window.map((c) => c.high));
  const low = Math.min(...window.map((c) => c.low));
  const last = candles.at(-1)!;
  const close = last.close;
  const { atr14, adx14 } = ctx.indicators;

  let signal: StrategyOutput["signal"] = "HOLD";
  let confidence = 35;
  let momentumScore = 0;

  if (close > high) {
    signal = "BUY";
    confidence = 60 + Math.min(25, ((close - high) / (atr14 ?? close)) * 30);
    momentumScore = 75;
    reasoning.push(`Close ${close.toFixed(2)} above 20-bar high ${high.toFixed(2)} — Donchian breakout.`);
  } else if (close < low) {
    signal = "SELL";
    confidence = 60 + Math.min(25, ((low - close) / (atr14 ?? close)) * 30);
    momentumScore = -75;
    reasoning.push(`Close ${close.toFixed(2)} below 20-bar low ${low.toFixed(2)} — Donchian breakdown.`);
  } else {
    reasoning.push("Price inside the 20-bar channel — no breakout to trade.");
  }

  if (signal !== "HOLD" && (adx14 ?? 0) < 18) {
    confidence -= 15;
    reasoning.push("ADX weak — breakout has lower follow-through odds.");
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
    strategyId: "donchian-breakout",
    strategyName: "Donchian Breakout",
    category: "breakout",
    signal: args.signal,
    confidence: Math.round(Math.min(92, Math.max(0, args.confidence))),
    timeframe: "intraday",
    regimeFit: ["Breakout", "Trending Up", "Trending Down", "High Volatility"],
    riskLevel: "Medium",
    reasoning: args.reasoning,
    indicatorsUsed: ["20-bar high/low", "ATR14", "ADX14"],
    entryConditions: ["Close beyond 20-bar Donchian extreme"],
    exitConditions: ["Close back inside Donchian channel", "ATR collapses"],
    stopLossLogic: "1× ATR inside the broken level.",
    takeProfitLogic: "2× ATR extension or 10-bar Donchian trailing exit.",
    volatilityScore: 65,
    momentumScore: args.momentumScore,
    trendScore: args.momentumScore * 0.6,
  };
}

export const DonchianBreakout: StrategyDefinition = {
  id: "donchian-breakout",
  name: "Donchian Breakout",
  category: "breakout",
  description:
    "Turtle-style 20-bar breakout entry — fast trigger for emerging trends and breakouts.",
  timeframes: ["intraday"],
  preferredRegimes: ["Breakout", "Trending Up", "Trending Down", "High Volatility"],
  minCandles: 25,
  evaluate,
  enabled: true,
};
