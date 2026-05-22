import type { StrategyContext, StrategyDefinition, StrategyOutput } from "@/strategy-core/types";

/**
 * Zeiierman-style adaptive volatility expansion.
 *
 * Concept: when realised volatility (we use ATR%) is *expanding* AND price
 * breaks out of a BB envelope (the "SuperBollingerTrend" proxy), trade the
 * direction of the expansion. AVSO (Adaptive Volatility Oscillator) is the
 * key bespoke input in the original script — we approximate by comparing the
 * latest ATR% to its 20-bar median, signing the result by recent price drift.
 */
function evaluate(ctx: StrategyContext): StrategyOutput {
  const { atrPct, bb, atr14 } = ctx.indicators;
  const reasoning: string[] = [];
  if (atrPct == null || !bb) {
    return shell({
      signal: "HOLD",
      confidence: 25,
      reasoning: ["ATR% / BB not stable yet."],
      volatilityScore: 50,
      momentumScore: 0,
    });
  }

  // Build a 20-bar ATR% history and read the median.
  const closes = ctx.candles.map((c) => c.close);
  if (closes.length < 30) {
    return shell({
      signal: "HOLD",
      confidence: 25,
      reasoning: ["Need ≥30 bars."],
      volatilityScore: 50,
      momentumScore: 0,
    });
  }
  const trs: number[] = [];
  for (let i = ctx.candles.length - 30; i < ctx.candles.length; i += 1) {
    const c = ctx.candles[i];
    const prev = i > 0 ? ctx.candles[i - 1].close : c.close;
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prev),
      Math.abs(c.low - prev),
    );
    trs.push(tr / c.close);
  }
  const sorted = [...trs].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const expansion = (atrPct / 100) / Math.max(0.0001, median); // >1.2 = expanding

  // Drift sign over last 6 bars.
  const drift = closes.at(-1)! - closes.at(-7)!;
  const driftSign = drift > 0 ? 1 : drift < 0 ? -1 : 0;
  const price = ctx.price;

  let signal: StrategyOutput["signal"] = "HOLD";
  let confidence = 35;
  let momentumScore = 0;
  let volatilityScore = Math.min(100, expansion * 50);

  if (expansion >= 1.3 && price > bb.upper && driftSign === 1) {
    signal = "BUY";
    confidence = 76;
    momentumScore = 70;
    volatilityScore = 85;
    reasoning.push(
      `Volatility expansion ${expansion.toFixed(2)}× median with breakout above BB upper (${bb.upper.toFixed(2)}).`,
    );
  } else if (expansion >= 1.3 && price < bb.lower && driftSign === -1) {
    signal = "SELL";
    confidence = 76;
    momentumScore = -70;
    volatilityScore = 85;
    reasoning.push(
      `Volatility expansion ${expansion.toFixed(2)}× median with breakdown below BB lower (${bb.lower.toFixed(2)}).`,
    );
  } else if (expansion < 0.8) {
    reasoning.push(
      `Volatility compressed (${expansion.toFixed(2)}× median) — no expansion trade.`,
    );
    volatilityScore = 25;
  } else {
    reasoning.push(
      `Vol expansion ${expansion.toFixed(2)}× but no clean band breakout in the drift direction.`,
    );
  }

  return shell({
    signal,
    confidence,
    reasoning,
    volatilityScore,
    momentumScore,
    suggestedStopLoss:
      signal === "BUY" ? bb.middle : signal === "SELL" ? bb.middle : undefined,
    suggestedTakeProfit:
      signal !== "HOLD" && atr14 != null
        ? price + driftSign * atr14 * 3
        : undefined,
  });
}

function shell(args: {
  signal: StrategyOutput["signal"];
  confidence: number;
  reasoning: string[];
  volatilityScore: number;
  momentumScore: number;
  suggestedStopLoss?: number;
  suggestedTakeProfit?: number;
}): StrategyOutput {
  return {
    strategyId: "zeiierman-volatility",
    strategyName: "Zeiierman Volatility Expansion",
    category: "volatility",
    signal: args.signal,
    confidence: Math.round(Math.min(86, Math.max(0, args.confidence))),
    timeframe: "intraday",
    regimeFit: ["Breakout", "High Volatility"],
    riskLevel: "High",
    reasoning: args.reasoning,
    indicatorsUsed: ["ATR%", "ATR% 20-bar median", "Bollinger Bands", "Drift sign"],
    entryConditions: [
      "Adaptive vol ≥ 1.3× 20-bar median",
      "Price breaks BB upper/lower in drift direction",
    ],
    exitConditions: ["Vol contracts below 0.9× median", "Price returns to BB middle"],
    stopLossLogic: "Bollinger middle band.",
    takeProfitLogic: "3× ATR extension or trailing BB middle.",
    volatilityScore: args.volatilityScore,
    momentumScore: args.momentumScore,
    trendScore: args.momentumScore * 0.5,
    suggestedStopLoss: args.suggestedStopLoss,
    suggestedTakeProfit: args.suggestedTakeProfit,
  };
}

export const ZeiiermanVolatility: StrategyDefinition = {
  id: "zeiierman-volatility",
  name: "Zeiierman Volatility Expansion",
  category: "volatility",
  description:
    "Adaptive volatility expansion — fires when realised vol exceeds 1.3× its 20-bar median and price breaks the Bollinger envelope in the drift direction.",
  timeframes: ["intraday", "short-term"],
  preferredRegimes: ["Breakout", "High Volatility"],
  minCandles: 30,
  evaluate,
  enabled: true,
};
