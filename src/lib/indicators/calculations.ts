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

