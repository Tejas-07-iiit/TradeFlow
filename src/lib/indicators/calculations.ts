import type { Candle } from "@/types/market";

/**
 * Simple moving average. Returns one value per bar; null while window fills.
 */
export function sma(values: number[], period: number): Array<number | null> {
  const result: Array<number | null> = Array(values.length).fill(null);
  if (values.length < period) return result;
  let sum = 0;
  for (let i = 0; i < period; i += 1) sum += values[i];
  result[period - 1] = sum / period;
  for (let i = period; i < values.length; i += 1) {
    sum += values[i] - values[i - period];
    result[i] = sum / period;
  }
  return result;
}

/**
 * Weighted moving average — linear weighting (1..period).
 */
export function wma(values: number[], period: number): Array<number | null> {
  const result: Array<number | null> = Array(values.length).fill(null);
  if (values.length < period) return result;
  const denom = (period * (period + 1)) / 2;
  for (let i = period - 1; i < values.length; i += 1) {
    let weighted = 0;
    for (let k = 0; k < period; k += 1) {
      weighted += values[i - period + 1 + k] * (k + 1);
    }
    result[i] = weighted / denom;
  }
  return result;
}

/**
 * Volume-weighted moving average over the last `period` bars.
 */
export function vwma(candles: Candle[], period: number): Array<number | null> {
  const result: Array<number | null> = Array(candles.length).fill(null);
  if (candles.length < period) return result;
  for (let i = period - 1; i < candles.length; i += 1) {
    let pv = 0;
    let v = 0;
    for (let k = i - period + 1; k <= i; k += 1) {
      pv += candles[k].close * candles[k].volume;
      v += candles[k].volume;
    }
    result[i] = v > 0 ? pv / v : null;
  }
  return result;
}

/**
 * Wilder's RMA — used by many TradingView indicators (RSI, ADX, ATR).
 */
export function rma(values: number[], period: number): Array<number | null> {
  const result: Array<number | null> = Array(values.length).fill(null);
  if (values.length < period) return result;
  let avg = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
  result[period - 1] = avg;
  for (let i = period; i < values.length; i += 1) {
    avg = (avg * (period - 1) + values[i]) / period;
    result[i] = avg;
  }
  return result;
}

export function ema(values: number[], period: number): Array<number | null> {
  if (values.length === 0) return [];
  const multiplier = 2 / (period + 1);
  const result: Array<number | null> = [];
  let previous: number | null = null;

  values.forEach((value, index) => {
    if (index < period - 1) {
      result.push(null);
      return;
    }

    if (index === period - 1) {
      previous =
        values.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
      result.push(previous);
      return;
    }

    previous = value * multiplier + (previous ?? value) * (1 - multiplier);
    result.push(previous);
  });

  return result;
}

export function rsi(values: number[], period = 14): Array<number | null> {
  const result: Array<number | null> = Array(values.length).fill(null);
  if (values.length <= period) return result;

  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= period; index += 1) {
    const diff = values[index] - values[index - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;
  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let index = period + 1; index < values.length; index += 1) {
    const diff = values[index] - values[index - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
    result[index] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  return result;
}

export function atr(candles: Candle[], period = 14): Array<number | null> {
  const result: Array<number | null> = Array(candles.length).fill(null);
  if (candles.length <= period) return result;

  const trueRanges = candles.map((candle, index) => {
    if (index === 0) return candle.high - candle.low;
    const prevClose = candles[index - 1].close;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - prevClose),
      Math.abs(candle.low - prevClose),
    );
  });

  let previous =
    trueRanges.slice(1, period + 1).reduce((sum, item) => sum + item, 0) /
    period;
  result[period] = previous;

  for (let index = period + 1; index < candles.length; index += 1) {
    previous = (previous * (period - 1) + trueRanges[index]) / period;
    result[index] = previous;
  }

  return result;
}

export function adx(candles: Candle[], period = 14): Array<number | null> {
  const result: Array<number | null> = Array(candles.length).fill(null);
  if (candles.length <= period * 2) return result;

  const tr: number[] = [];
  const plusDm: number[] = [];
  const minusDm: number[] = [];

  for (let index = 1; index < candles.length; index += 1) {
    const current = candles[index];
    const previous = candles[index - 1];
    const upMove = current.high - previous.high;
    const downMove = previous.low - current.low;
    tr.push(
      Math.max(
        current.high - current.low,
        Math.abs(current.high - previous.close),
        Math.abs(current.low - previous.close),
      ),
    );
    plusDm.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDm.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  let smoothTr = tr.slice(0, period).reduce((sum, item) => sum + item, 0);
  let smoothPlus = plusDm.slice(0, period).reduce((sum, item) => sum + item, 0);
  let smoothMinus = minusDm.slice(0, period).reduce((sum, item) => sum + item, 0);
  const dxValues: number[] = [];

  for (let index = period; index < tr.length; index += 1) {
    smoothTr = smoothTr - smoothTr / period + tr[index];
    smoothPlus = smoothPlus - smoothPlus / period + plusDm[index];
    smoothMinus = smoothMinus - smoothMinus / period + minusDm[index];

    const plusDi = smoothTr === 0 ? 0 : (100 * smoothPlus) / smoothTr;
    const minusDi = smoothTr === 0 ? 0 : (100 * smoothMinus) / smoothTr;
    const dx =
      plusDi + minusDi === 0
        ? 0
        : (100 * Math.abs(plusDi - minusDi)) / (plusDi + minusDi);
    dxValues.push(dx);

    if (dxValues.length === period) {
      result[index + 1] =
        dxValues.reduce((sum, item) => sum + item, 0) / period;
    } else if (dxValues.length > period) {
      const previousAdx = result[index] ?? dx;
      result[index + 1] = (previousAdx * (period - 1) + dx) / period;
    }
  }

  return result;
}

export function lastNumber(values: Array<number | null>) {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

export function lastValue<T>(values: Array<T | null>): T | null {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (value !== null && value !== undefined) return value;
  }
  return null;
}

function stdDev(values: number[], mean: number): number {
  const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
  return Math.sqrt(variance);
}

export function bollingerBands(closes: number[], period = 20, multiplier = 2) {
  const result: Array<{ upper: number; middle: number; lower: number } | null> = Array(closes.length).fill(null);
  if (closes.length < period) return result;

  for (let i = period - 1; i < closes.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1);
    const middle = slice.reduce((a, b) => a + b, 0) / period;
    const std = stdDev(slice, middle);
    result[i] = {
      upper: middle + std * multiplier,
      middle,
      lower: middle - std * multiplier,
    };
  }
  return result;
}

/**
 * Rolling z-score of the close series: how many standard deviations the
 * latest print sits above (positive) or below (negative) the rolling mean.
 *
 * Use case: a clean quantification of "stretched from the mean" for
 * mean-reversion entries. |z| > 2 is the textbook 95th-percentile threshold;
 * inside that band the price is statistically "normal."
 *
 * Returns one value per input bar (or null while the window is filling).
 */
export function zScore(closes: number[], period = 20): Array<number | null> {
  const result: Array<number | null> = Array(closes.length).fill(null);
  if (closes.length < period) return result;
  for (let i = period - 1; i < closes.length; i += 1) {
    const slice = closes.slice(i - period + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const sd = stdDev(slice, mean);
    result[i] = sd === 0 ? 0 : (closes[i] - mean) / sd;
  }
  return result;
}

/**
 * Anchored VWAP from the start of the candle series. Crypto trades 24/7 so
 * there is no natural "session reset" — callers can re-anchor by slicing the
 * candle array before calling. Each output is the cumulative
 *   Σ (typicalPrice * volume) / Σ volume
 * up to and including that bar.
 */
export function vwap(candles: Candle[]): Array<number | null> {
  const result: Array<number | null> = Array(candles.length).fill(null);
  let cumPV = 0;
  let cumV = 0;
  for (let i = 0; i < candles.length; i += 1) {
    const c = candles[i];
    const typical = (c.high + c.low + c.close) / 3;
    cumPV += typical * c.volume;
    cumV += c.volume;
    result[i] = cumV > 0 ? cumPV / cumV : null;
  }
  return result;
}

/**
 * Sign of the slope across the last `lookback` non-null VWAP values.
 * Returns +1 (rising), -1 (falling), or 0 (flat / insufficient data).
 */
export function vwapSlope(
  vwapSeries: Array<number | null>,
  lookback = 10,
): -1 | 0 | 1 {
  const trimmed = vwapSeries.filter(
    (v): v is number => v !== null && Number.isFinite(v),
  );
  if (trimmed.length < lookback + 1) return 0;
  const a = trimmed[trimmed.length - 1 - lookback];
  const b = trimmed[trimmed.length - 1];
  const diff = b - a;
  // Treat very small drifts as flat to avoid noise-driven flips.
  const noise = Math.abs(b) * 0.0005;
  if (diff > noise) return 1;
  if (diff < -noise) return -1;
  return 0;
}

/**
 * Parabolic SAR — directional stop-and-reverse.
 * Output per bar: { value, trend } where trend is +1 (long) or -1 (short).
 * Source values default to candle highs/lows; pass an arbitrary `highSrc`/
 * `lowSrc` (equal arrays) to run PSAR over a non-price series like RSI.
 */
export function parabolicSar(
  candles: Candle[],
  step = 0.02,
  max = 0.2,
  highSrc?: number[],
  lowSrc?: number[],
): Array<{ value: number; trend: 1 | -1 } | null> {
  const n = candles.length;
  const out: Array<{ value: number; trend: 1 | -1 } | null> = Array(n).fill(null);
  if (n < 3) return out;
  const highs = highSrc ?? candles.map((c) => c.high);
  const lows = lowSrc ?? candles.map((c) => c.low);

  let trend: 1 | -1 = highs[1] >= highs[0] ? 1 : -1;
  let sar = trend === 1 ? lows[0] : highs[0];
  let ep = trend === 1 ? highs[1] : lows[1];
  let af = step;
  out[1] = { value: sar, trend };

  for (let i = 2; i < n; i += 1) {
    sar = sar + af * (ep - sar);
    if (trend === 1) {
      sar = Math.min(sar, lows[i - 1], lows[i - 2]);
      if (lows[i] < sar) {
        trend = -1;
        sar = ep;
        ep = lows[i];
        af = step;
      } else if (highs[i] > ep) {
        ep = highs[i];
        af = Math.min(max, af + step);
      }
    } else {
      sar = Math.max(sar, highs[i - 1], highs[i - 2]);
      if (highs[i] > sar) {
        trend = 1;
        sar = ep;
        ep = highs[i];
        af = step;
      } else if (lows[i] < ep) {
        ep = lows[i];
        af = Math.min(max, af + step);
      }
    }
    out[i] = { value: sar, trend };
  }
  return out;
}

/**
 * Supertrend — ATR-based stop-and-reverse trend line.
 * trend = +1 when price is above the line (long regime), -1 below.
 */
export function supertrend(
  candles: Candle[],
  period = 10,
  multiplier = 3,
): Array<{ value: number; trend: 1 | -1 } | null> {
  const n = candles.length;
  const out: Array<{ value: number; trend: 1 | -1 } | null> = Array(n).fill(null);
  const atrs = atr(candles, period);
  let prevUpper = 0;
  let prevLower = 0;
  let prevTrend: 1 | -1 = 1;
  let prevFinalUpper = 0;
  let prevFinalLower = 0;

  for (let i = 0; i < n; i += 1) {
    const a = atrs[i];
    if (a == null) continue;
    const hl2 = (candles[i].high + candles[i].low) / 2;
    const basicUpper = hl2 + multiplier * a;
    const basicLower = hl2 - multiplier * a;
    const finalUpper =
      basicUpper < prevFinalUpper || (candles[i - 1]?.close ?? 0) > prevFinalUpper
        ? basicUpper
        : prevFinalUpper;
    const finalLower =
      basicLower > prevFinalLower || (candles[i - 1]?.close ?? 0) < prevFinalLower
        ? basicLower
        : prevFinalLower;
    let trend: 1 | -1 = prevTrend;
    if (prevTrend === 1 && candles[i].close < finalLower) trend = -1;
    else if (prevTrend === -1 && candles[i].close > finalUpper) trend = 1;
    const value = trend === 1 ? finalLower : finalUpper;
    out[i] = { value, trend };
    prevUpper = basicUpper;
    prevLower = basicLower;
    prevTrend = trend;
    prevFinalUpper = finalUpper;
    prevFinalLower = finalLower;
  }
  // Reference the unused locals to keep TS happy without altering semantics.
  void prevUpper;
  void prevLower;
  return out;
}

/**
 * Keltner Channels — EMA mid with ATR-multiplier envelopes.
 */
export function keltnerChannels(
  candles: Candle[],
  period = 20,
  atrPeriod = 10,
  multiplier = 1.5,
): Array<{ upper: number; middle: number; lower: number } | null> {
  const closes = candles.map((c) => c.close);
  const emaSeries = ema(closes, period);
  const atrSeries = atr(candles, atrPeriod);
  return closes.map((_, i) => {
    const mid = emaSeries[i];
    const a = atrSeries[i];
    if (mid == null || a == null) return null;
    return { upper: mid + multiplier * a, middle: mid, lower: mid - multiplier * a };
  });
}

/**
 * WaveTrend (LazyBear) — momentum oscillator.
 * channelLen=10, averageLen=21 are the canonical Pine values.
 */
export function waveTrend(
  candles: Candle[],
  channelLen = 10,
  averageLen = 21,
  smaLen = 4,
): Array<{ wt1: number; wt2: number } | null> {
  const n = candles.length;
  const tp = candles.map((c) => (c.high + c.low + c.close) / 3);
  const esa = ema(tp, channelLen);
  const d: Array<number | null> = tp.map((v, i) => {
    const e = esa[i];
    return e == null ? null : Math.abs(v - e);
  });
  const dValid = d.map((v) => (v == null ? 0 : v));
  const dEma = ema(dValid, channelLen);
  const ci: Array<number | null> = tp.map((v, i) => {
    const e = esa[i];
    const de = dEma[i];
    if (e == null || de == null || de === 0) return null;
    return (v - e) / (0.015 * de);
  });
  const ciValid = ci.map((v) => (v == null ? 0 : v));
  const wt1Series = ema(ciValid, averageLen);
  const wt1Valid = wt1Series.map((v) => (v == null ? 0 : v));
  const wt2Series = sma(wt1Valid, smaLen);
  const out: Array<{ wt1: number; wt2: number } | null> = Array(n).fill(null);
  for (let i = 0; i < n; i += 1) {
    const a = wt1Series[i];
    const b = wt2Series[i];
    if (a == null || b == null) continue;
    out[i] = { wt1: a, wt2: b };
  }
  return out;
}

/**
 * Ichimoku Cloud — tenkan, kijun, senkouA/B (plotted ahead), chikou (plotted
 * behind). We return raw values at the current bar; consumers can shift if
 * they want the projected-ahead semantics of the Pine plot.
 */
export function ichimoku(
  candles: Candle[],
  tenkanLen = 9,
  kijunLen = 26,
  senkouBLen = 52,
): Array<{
  tenkan: number;
  kijun: number;
  senkouA: number;
  senkouB: number;
  chikou: number | null;
} | null> {
  const n = candles.length;
  const out = Array<{
    tenkan: number;
    kijun: number;
    senkouA: number;
    senkouB: number;
    chikou: number | null;
  } | null>(n).fill(null);

  const midRange = (start: number, end: number) => {
    let hi = -Infinity;
    let lo = Infinity;
    for (let k = start; k <= end; k += 1) {
      if (candles[k].high > hi) hi = candles[k].high;
      if (candles[k].low < lo) lo = candles[k].low;
    }
    return (hi + lo) / 2;
  };

  for (let i = 0; i < n; i += 1) {
    if (i < senkouBLen - 1) continue;
    const tenkan = midRange(i - tenkanLen + 1, i);
    const kijun = midRange(i - kijunLen + 1, i);
    const senkouA = (tenkan + kijun) / 2;
    const senkouB = midRange(i - senkouBLen + 1, i);
    const chikou = i + kijunLen < n ? candles[i + kijunLen].close : null;
    out[i] = { tenkan, kijun, senkouA, senkouB, chikou };
  }
  return out;
}

/**
 * Money Flow Index — RSI-style oscillator weighted by volume.
 */
export function mfi(candles: Candle[], period = 14): Array<number | null> {
  const n = candles.length;
  const out: Array<number | null> = Array(n).fill(null);
  if (n <= period) return out;
  const typical = candles.map((c) => (c.high + c.low + c.close) / 3);
  const rawFlow = candles.map((c, i) => typical[i] * c.volume);
  const positive: number[] = Array(n).fill(0);
  const negative: number[] = Array(n).fill(0);
  for (let i = 1; i < n; i += 1) {
    if (typical[i] > typical[i - 1]) positive[i] = rawFlow[i];
    else if (typical[i] < typical[i - 1]) negative[i] = rawFlow[i];
  }
  for (let i = period; i < n; i += 1) {
    let posSum = 0;
    let negSum = 0;
    for (let k = i - period + 1; k <= i; k += 1) {
      posSum += positive[k];
      negSum += negative[k];
    }
    if (negSum === 0) {
      out[i] = 100;
    } else {
      const ratio = posSum / negSum;
      out[i] = 100 - 100 / (1 + ratio);
    }
  }
  return out;
}

/**
 * Tillson T3 — triple-smoothed EMA. b ∈ [0,1] is the "hot" parameter (0.7
 * is the canonical Tillson value).
 */
export function t3(values: number[], period = 8, b = 0.7): Array<number | null> {
  const e1 = ema(values, period);
  const e2 = ema(e1.map((v) => (v == null ? 0 : v)), period);
  const e3 = ema(e2.map((v) => (v == null ? 0 : v)), period);
  const e4 = ema(e3.map((v) => (v == null ? 0 : v)), period);
  const e5 = ema(e4.map((v) => (v == null ? 0 : v)), period);
  const e6 = ema(e5.map((v) => (v == null ? 0 : v)), period);
  const b2 = b * b;
  const b3 = b2 * b;
  const c1 = -b3;
  const c2 = 3 * b2 + 3 * b3;
  const c3 = -6 * b2 - 3 * b - 3 * b3;
  const c4 = 1 + 3 * b + b3 + 3 * b2;
  return values.map((_, i) => {
    const v3 = e3[i];
    const v4 = e4[i];
    const v5 = e5[i];
    const v6 = e6[i];
    if (v3 == null || v4 == null || v5 == null || v6 == null) return null;
    return c1 * v6 + c2 * v5 + c3 * v4 + c4 * v3;
  });
}

/**
 * Heiken Ashi conversion. Returns a parallel candle array. Pure transform —
 * does not depend on indicator context.
 */
export function heikenAshi(candles: Candle[]): Candle[] {
  if (candles.length === 0) return [];
  const out: Candle[] = [];
  let prevHaOpen = (candles[0].open + candles[0].close) / 2;
  let prevHaClose = (candles[0].open + candles[0].high + candles[0].low + candles[0].close) / 4;
  for (let i = 0; i < candles.length; i += 1) {
    const c = candles[i];
    const haClose = (c.open + c.high + c.low + c.close) / 4;
    const haOpen = i === 0 ? prevHaOpen : (prevHaOpen + prevHaClose) / 2;
    const haHigh = Math.max(c.high, haOpen, haClose);
    const haLow = Math.min(c.low, haOpen, haClose);
    out.push({ ...c, open: haOpen, close: haClose, high: haHigh, low: haLow });
    prevHaOpen = haOpen;
    prevHaClose = haClose;
  }
  return out;
}

/**
 * Commodity Channel Index — used by the Lorentzian classifier feature set.
 */
export function cci(candles: Candle[], period = 20): Array<number | null> {
  const n = candles.length;
  const out: Array<number | null> = Array(n).fill(null);
  if (n < period) return out;
  const tp = candles.map((c) => (c.high + c.low + c.close) / 3);
  for (let i = period - 1; i < n; i += 1) {
    let mean = 0;
    for (let k = i - period + 1; k <= i; k += 1) mean += tp[k];
    mean /= period;
    let md = 0;
    for (let k = i - period + 1; k <= i; k += 1) md += Math.abs(tp[k] - mean);
    md /= period;
    out[i] = md === 0 ? 0 : (tp[i] - mean) / (0.015 * md);
  }
  return out;
}

export function macd(closes: number[], fast = 12, slow = 26, signal = 9) {
  const result: Array<{ macd: number; signalLine: number; histogram: number } | null> = Array(closes.length).fill(null);
  
  const fastEma = ema(closes, fast);
  const slowEma = ema(closes, slow);
  
  const macdLine: (number | null)[] = closes.map((_, i) => {
    if (fastEma[i] !== null && slowEma[i] !== null) {
      return fastEma[i]! - slowEma[i]!;
    }
    return null;
  });
  
  const firstValidIndex = macdLine.findIndex(v => v !== null);
  if (firstValidIndex === -1) return result;
  
  const validMacdValues = macdLine.slice(firstValidIndex) as number[];
  const signalEma = ema(validMacdValues, signal);
  
  for (let i = 0; i < validMacdValues.length; i++) {
    const m = validMacdValues[i];
    const s = signalEma[i];
    if (m !== null && s !== null) {
      result[i + firstValidIndex] = {
        macd: m,
        signalLine: s,
        histogram: m - s
      };
    }
  }
  
  return result;
}

