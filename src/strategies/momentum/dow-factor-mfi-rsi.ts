import type { StrategyContext, StrategyDefinition, StrategyOutput } from "@/strategy-core/types";
import type { Candle } from "@/types/market";

/**
 * Dow Factor + MFI/RSI/DVOG — combines Dow swing structure with momentum
 * and volume confirmation.
 *
 * Dow Factor:
 *   +1 when the latest pivot high > prior pivot high AND latest pivot low >
 *      prior pivot low (HH + HL = uptrend)
 *   -1 when LH + LL (downtrend)
 *    0 otherwise
 *
 * DVOG (Divergence Volume Oscillator Gradient) — original is bespoke; we
 * approximate with normalised volume slope over the last 10 bars (+ = volume
 * expansion supporting the move).
 */
function findPivots(candles: Candle[], left = 3, right = 3): { highs: number[]; lows: number[] } {
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = left; i < candles.length - right; i += 1) {
    let isHigh = true;
    let isLow = true;
    for (let k = i - left; k <= i + right; k += 1) {
      if (k === i) continue;
      if (candles[k].high >= candles[i].high) isHigh = false;
      if (candles[k].low <= candles[i].low) isLow = false;
    }
    if (isHigh) highs.push(candles[i].high);
    if (isLow) lows.push(candles[i].low);
  }
  return { highs, lows };
}

function dowFactor(candles: Candle[]): -1 | 0 | 1 {
  const { highs, lows } = findPivots(candles);
  if (highs.length < 2 || lows.length < 2) return 0;
  const hh = highs.at(-1)! > highs.at(-2)!;
  const lh = highs.at(-1)! < highs.at(-2)!;
  const hl = lows.at(-1)! > lows.at(-2)!;
  const ll = lows.at(-1)! < lows.at(-2)!;
  if (hh && hl) return 1;
  if (lh && ll) return -1;
  return 0;
}

function dvogProxy(candles: Candle[], window = 10): number {
  if (candles.length < window + 1) return 0;
  const slice = candles.slice(-window);
  let sum = 0;
  for (let i = 1; i < slice.length; i += 1) {
    sum += Math.sign(slice[i].close - slice[i - 1].close) * slice[i].volume;
  }
  const avgVol = slice.reduce((s, c) => s + c.volume, 0) / slice.length;
  return avgVol === 0 ? 0 : sum / (avgVol * window);
}

function evaluate(ctx: StrategyContext): StrategyOutput {
  const { rsi14, mfi14 } = ctx.indicators;
  const reasoning: string[] = [];

  if (ctx.candles.length < 30) {
    return shell({
      signal: "HOLD",
      confidence: 25,
      reasoning: ["Need ≥30 bars to derive Dow swings."],
      momentumScore: 0,
    });
  }

  const dow = dowFactor(ctx.candles);
  const dvog = dvogProxy(ctx.candles);
  const rsi = rsi14 ?? 50;
  const mfi = mfi14 ?? 50;

  let signal: StrategyOutput["signal"] = "HOLD";
  let confidence = 35;
  let momentumScore = 0;

  if (dow === 1 && rsi > 50 && mfi > 50 && dvog > 0.05) {
    signal = "BUY";
    confidence = 70 + Math.min(15, Math.max(0, rsi - 55));
    momentumScore = 65;
    reasoning.push(
      `Dow=+1 (HH + HL), RSI ${rsi.toFixed(0)} > 50, MFI ${mfi.toFixed(0)} > 50, DVOG ${dvog.toFixed(2)} expanding — bullish confluence.`,
    );
  } else if (dow === -1 && rsi < 50 && mfi < 50 && dvog < -0.05) {
    signal = "SELL";
    confidence = 70 + Math.min(15, Math.max(0, 45 - rsi));
    momentumScore = -65;
    reasoning.push(
      `Dow=-1 (LH + LL), RSI ${rsi.toFixed(0)} < 50, MFI ${mfi.toFixed(0)} < 50, DVOG ${dvog.toFixed(2)} contracting — bearish confluence.`,
    );
  } else {
    reasoning.push(
      `Dow=${dow}, RSI=${rsi.toFixed(0)}, MFI=${mfi.toFixed(0)}, DVOG=${dvog.toFixed(2)} — confluence incomplete.`,
    );
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
    strategyId: "dow-factor-mfi-rsi",
    strategyName: "Dow Factor + MFI/RSI/DVOG",
    category: "momentum",
    signal: args.signal,
    confidence: Math.round(Math.min(88, Math.max(0, args.confidence))),
    timeframe: "swing",
    regimeFit: ["Trending Up", "Trending Down", "Breakout"],
    riskLevel: "Medium",
    reasoning: args.reasoning,
    indicatorsUsed: ["Dow swing pivots", "RSI14", "MFI14", "DVOG (volume slope)"],
    entryConditions: [
      "Dow trend = +1 (HH+HL) for long, -1 (LH+LL) for short",
      "RSI and MFI both on the trade side of 50",
      "DVOG volume slope agrees with trade direction",
    ],
    exitConditions: [
      "Dow structure flips",
      "RSI or MFI cross back through 50",
    ],
    stopLossLogic: "Last confirmed Dow pivot in opposite direction.",
    takeProfitLogic: "Next pivot projection (1× swing range from entry).",
    volatilityScore: 50,
    momentumScore: args.momentumScore,
    trendScore: args.momentumScore * 0.8,
  };
}

export const DowFactorMfiRsi: StrategyDefinition = {
  id: "dow-factor-mfi-rsi",
  name: "Dow Factor + MFI/RSI",
  category: "momentum",
  description:
    "Dow Theory swing structure (HH+HL / LH+LL) confirmed by RSI, MFI and DVOG volume slope — high-confluence multi-factor momentum.",
  timeframes: ["swing", "short-term"],
  preferredRegimes: ["Trending Up", "Trending Down", "Breakout"],
  minCandles: 30,
  evaluate,
  enabled: true,
};
