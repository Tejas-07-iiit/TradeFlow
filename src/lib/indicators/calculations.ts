import type { Candle } from "@/types/market";

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

