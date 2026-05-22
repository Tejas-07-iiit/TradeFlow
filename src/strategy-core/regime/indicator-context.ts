import {
  adx,
  atr,
  bollingerBands,
  cci,
  ema,
  ichimoku,
  keltnerChannels,
  lastNumber,
  lastValue,
  macd,
  mfi,
  parabolicSar,
  rsi,
  sma,
  supertrend,
  t3,
  waveTrend,
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

  const sma50 = lastNumber(sma(closes, 50));
  const sma200 = lastNumber(sma(closes, 200));
  const psar = lastValue(parabolicSar(candles));
  const keltner = lastValue(keltnerChannels(candles, 20, 10, 1.5));
  const wave = lastValue(waveTrend(candles, 10, 21, 4));
  const ichi = lastValue(ichimoku(candles, 9, 26, 52));
  const mfi14 = lastNumber(mfi(candles, 14));
  const t3v = lastNumber(t3(closes, 8, 0.7));
  const cci20 = lastNumber(cci(candles, 20));

  // PSAR on the RSI series itself — Parabolic RSI strategy needs this.
  const rsiSeries = rsi(closes, 14);
  const rsiValues = rsiSeries
    .map((v) => (v == null ? Number.NaN : v))
    .filter((v) => !Number.isNaN(v));
  let psarOnRsi: IndicatorContext["psarOnRsi"] = null;
  if (rsiValues.length >= 5) {
    const synthetic = rsiValues.map(
      (v) =>
        ({
          time: 0,
          open: v,
          high: v,
          low: v,
          close: v,
          volume: 0,
        }) as Candle,
    );
    const psarSeries = parabolicSar(synthetic);
    const last = lastValue(psarSeries);
    const lastRsi = rsiValues.at(-1);
    if (last && lastRsi != null) {
      psarOnRsi = { value: last.value, trend: last.trend, rsi: lastRsi };
    }
  }

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
    sma50,
    sma200,
    psar,
    psarOnRsi,
    keltner,
    waveTrend: wave,
    ichimoku: ichi,
    mfi14,
    t3: t3v,
    cci20,
  };
}

/** Re-export so strategies that need triple supertrend can call directly. */
export { supertrend };

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
    sma50: null,
    sma200: null,
    psar: null,
    psarOnRsi: null,
    keltner: null,
    waveTrend: null,
    ichimoku: null,
    mfi14: null,
    t3: null,
    cci20: null,
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
