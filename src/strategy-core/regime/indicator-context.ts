import {
  adx,
  atr,
  bollingerBands,
  ema,
  lastNumber,
  lastValue,
  macd,
  rsi,
} from "@/lib/indicators/calculations";
import type { Candle } from "@/types/market";

import type { IndicatorContext } from "../types";

/**
 * Build the shared indicator context that every strategy reads.
 *
 * Computed ONCE per pipeline tick — strategies must not recompute indicators
 * themselves. Anything a strategy commonly needs lives here; bespoke
 * calculations stay inside the strategy module.
 */
export function buildIndicatorContext(candles: Candle[]): IndicatorContext {
  if (candles.length < 20) {
    return emptyContext();
  }

  const closes = candles.map((c) => c.close);
  const ema20 = lastNumber(ema(closes, 20));
  const ema50 = lastNumber(ema(closes, 50));
  const ema200 = lastNumber(ema(closes, 200));
  const rsi14 = lastNumber(rsi(closes, 14));
  const atr14 = lastNumber(atr(candles, 14));
  const adx14 = lastNumber(adx(candles, 14));
  const lastClose = closes.at(-1) ?? null;
  const atrPct = atr14 && lastClose ? (atr14 / lastClose) * 100 : null;
  const bb = lastValue(bollingerBands(closes, 20, 2));
  const macdVal = lastValue(macd(closes, 12, 26, 9));

  const momentum12 = computeMomentum(closes, 12);
  const rangeHigh52 = computeRange(candles, 52, "high");
  const rangeLow52 = computeRange(candles, 52, "low");
  const realizedVol = computeRealizedVol(closes, 20);

  return {
    ema20,
    ema50,
    ema200,
    rsi14,
    atr14,
    adx14,
    atrPct,
    bb,
    macd: macdVal,
    momentum12,
    rangeHigh52,
    rangeLow52,
    realizedVol,
  };
}

function emptyContext(): IndicatorContext {
  return {
    ema20: null,
    ema50: null,
    ema200: null,
    rsi14: null,
    atr14: null,
    adx14: null,
    atrPct: null,
    bb: null,
    macd: null,
    momentum12: null,
    rangeHigh52: null,
    rangeLow52: null,
    realizedVol: null,
  };
}

function computeMomentum(closes: number[], lookback: number): number | null {
  if (closes.length <= lookback) return null;
  const past = closes[closes.length - 1 - lookback];
  const now = closes[closes.length - 1];
  if (!past) return null;
  return (now - past) / past;
}

function computeRange(
  candles: Candle[],
  lookback: number,
  side: "high" | "low",
): number | null {
  if (candles.length < lookback) return null;
  const window = candles.slice(-lookback);
  return side === "high"
    ? Math.max(...window.map((c) => c.high))
    : Math.min(...window.map((c) => c.low));
}

function computeRealizedVol(closes: number[], lookback: number): number | null {
  if (closes.length <= lookback) return null;
  const window = closes.slice(-lookback - 1);
  const logReturns: number[] = [];
  for (let i = 1; i < window.length; i += 1) {
    logReturns.push(Math.log(window[i] / window[i - 1]));
  }
  const mean =
    logReturns.reduce((sum, r) => sum + r, 0) / Math.max(1, logReturns.length);
  const variance =
    logReturns.reduce((sum, r) => sum + (r - mean) ** 2, 0) /
    Math.max(1, logReturns.length);
  return Math.sqrt(variance);
}
