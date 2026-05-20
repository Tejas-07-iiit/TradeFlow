import type { Candle } from "@/types/market";

/**
 * TA-Lib CCandleSettingType primitives — the foundation every CDL function
 * is built on. Faithful to the upstream defaults documented in
 * `/Ta-lib/talib/_func.pxi` and the C source headers.
 *
 * The averaging period + factor table below mirrors `TA_SetCandleSettings`
 * defaults. We expose them as `SETTINGS` so future tuning (e.g. crypto-
 * specific calibration) can override individual rows without re-touching
 * 61 detectors.
 *
 * All helpers operate on a *window* of candles addressed by `endIdx`. The
 * window is read-only; detectors never mutate.
 */

export type RangeKind =
  | "BodyLong"
  | "BodyVeryLong"
  | "BodyShort"
  | "BodyDoji"
  | "ShadowLong"
  | "ShadowVeryLong"
  | "ShadowShort"
  | "ShadowVeryShort"
  | "Near"
  | "Far"
  | "Equal";

interface Setting {
  period: number;
  factor: number;
  /** Which raw geometric quantity to average. */
  metric: "body" | "highLow" | "shadows" | "real";
}

/**
 * Defaults aligned with TA-Lib's `TA_CandleDefaultSettings`. `period=0`
 * means "use the bar's own metric directly without averaging" (TA-Lib
 * encodes this by skipping the SMA pass).
 */
export const SETTINGS: Record<RangeKind, Setting> = {
  BodyLong: { period: 10, factor: 1.0, metric: "body" },
  BodyVeryLong: { period: 10, factor: 3.0, metric: "body" },
  BodyShort: { period: 10, factor: 1.0, metric: "body" },
  BodyDoji: { period: 10, factor: 0.1, metric: "highLow" },
  ShadowLong: { period: 0, factor: 1.0, metric: "real" },
  ShadowVeryLong: { period: 0, factor: 2.0, metric: "real" },
  ShadowShort: { period: 10, factor: 1.0, metric: "shadows" },
  ShadowVeryShort: { period: 10, factor: 0.1, metric: "highLow" },
  Near: { period: 5, factor: 0.2, metric: "highLow" },
  Far: { period: 5, factor: 0.6, metric: "highLow" },
  Equal: { period: 5, factor: 0.05, metric: "highLow" },
};

// ─── Single-candle geometry ────────────────────────────────────────────────

export const realBody = (c: Candle) => Math.abs(c.close - c.open);
export const highLowRange = (c: Candle) => c.high - c.low;
export const upperShadow = (c: Candle) =>
  c.high - Math.max(c.open, c.close);
export const lowerShadow = (c: Candle) =>
  Math.min(c.open, c.close) - c.low;
export const isWhite = (c: Candle) => c.close > c.open;
export const isBlack = (c: Candle) => c.close < c.open;
export const candleColor = (c: Candle): 1 | -1 | 0 =>
  c.close > c.open ? 1 : c.close < c.open ? -1 : 0;
/** Body midpoint — TA-Lib uses this for several "near body middle" tests. */
export const bodyMid = (c: Candle) => (c.open + c.close) / 2;
/** Total range of just the shadows (high-low minus body). */
export const totalShadows = (c: Candle) =>
  highLowRange(c) - realBody(c);

// ─── Averaging primitive ───────────────────────────────────────────────────

/**
 * `candleAverage(kind, candles, endIdx)` returns TA-Lib's
 *   factor * SMA(metric, period) over the window [endIdx-period .. endIdx-1]
 *
 * That `endIdx-period .. endIdx-1` window (exclusive of the bar being
 * evaluated) mirrors TA-Lib's behaviour — the bar under test is compared
 * against the *prior* averaging window, not the window including itself.
 *
 * Returns 0 when `period == 0` and `metric != "real"` (the C lib treats
 * those settings as direct, not averaged).
 */
export function candleAverage(
  kind: RangeKind,
  candles: Candle[],
  endIdx: number,
): number {
  const setting = SETTINGS[kind];
  // Period 0: the upstream lib uses the bar's *own* metric without averaging
  // for the "real" metric (Shadow Long / Very Long), so callers should handle
  // those cases by computing the raw quantity directly. We still return 0
  // here so any accidental average() call on a period-0 setting falls into a
  // safe no-op rather than dividing by zero.
  if (setting.period === 0) return 0;

  const start = endIdx - setting.period;
  if (start < 0) return 0;

  let sum = 0;
  for (let i = start; i < endIdx; i += 1) {
    const c = candles[i];
    sum += metricOf(setting.metric, c);
  }
  const avg = sum / setting.period;
  // TA-Lib divides the highLow/shadows averages by 2 for some settings.
  // We follow the upstream convention: the factor in `SETTINGS` is *already*
  // the published constant — but TA-Lib's internal _ta_RangeFunction maps
  // metric "highLow" via /2 only for ShadowVeryShort+Near+Far+Equal+BodyDoji.
  // We replicate that here.
  if (
    setting.metric === "highLow" &&
    (kind === "BodyDoji" ||
      kind === "ShadowVeryShort" ||
      kind === "Near" ||
      kind === "Far" ||
      kind === "Equal")
  ) {
    return (setting.factor * avg) / 2;
  }
  return setting.factor * avg;
}

function metricOf(metric: Setting["metric"], c: Candle): number {
  switch (metric) {
    case "body":
      return realBody(c);
    case "highLow":
      return highLowRange(c);
    case "shadows":
      return upperShadow(c) + lowerShadow(c);
    case "real":
      // For "real" period-0 settings, the average() call is a no-op; callers
      // read the raw shadow length directly via `upperShadow` / `lowerShadow`.
      return realBody(c);
  }
}

// ─── Threshold helpers (sugar over candleAverage + raw metric) ─────────────

export function isBodyLong(candles: Candle[], i: number): boolean {
  return realBody(candles[i]) > candleAverage("BodyLong", candles, i);
}

export function isBodyVeryLong(candles: Candle[], i: number): boolean {
  return realBody(candles[i]) > candleAverage("BodyVeryLong", candles, i);
}

export function isBodyShort(candles: Candle[], i: number): boolean {
  return realBody(candles[i]) < candleAverage("BodyShort", candles, i);
}

export function isDojiBody(candles: Candle[], i: number): boolean {
  return realBody(candles[i]) <= candleAverage("BodyDoji", candles, i);
}

export function isShadowShort(
  candles: Candle[],
  i: number,
  side: "upper" | "lower" | "both",
): boolean {
  const c = candles[i];
  const threshold = candleAverage("ShadowShort", candles, i);
  if (side === "upper") return upperShadow(c) < threshold;
  if (side === "lower") return lowerShadow(c) < threshold;
  return upperShadow(c) + lowerShadow(c) < threshold;
}

export function isShadowVeryShort(
  candles: Candle[],
  i: number,
  side: "upper" | "lower",
): boolean {
  const c = candles[i];
  const threshold = candleAverage("ShadowVeryShort", candles, i);
  if (side === "upper") return upperShadow(c) < threshold;
  return lowerShadow(c) < threshold;
}

export function isShadowLong(
  candles: Candle[],
  i: number,
  side: "upper" | "lower",
): boolean {
  const c = candles[i];
  // Shadow Long is period=0, factor=1.0 → compare against the real body.
  const threshold = SETTINGS.ShadowLong.factor * realBody(c);
  if (side === "upper") return upperShadow(c) > threshold;
  return lowerShadow(c) > threshold;
}

export function isShadowVeryLong(
  candles: Candle[],
  i: number,
  side: "upper" | "lower",
): boolean {
  const c = candles[i];
  const threshold = SETTINGS.ShadowVeryLong.factor * realBody(c);
  if (side === "upper") return upperShadow(c) > threshold;
  return lowerShadow(c) > threshold;
}

export function isNear(
  candles: Candle[],
  i: number,
  a: number,
  b: number,
): boolean {
  return Math.abs(a - b) <= candleAverage("Near", candles, i);
}

export function isFar(
  candles: Candle[],
  i: number,
  a: number,
  b: number,
): boolean {
  return Math.abs(a - b) >= candleAverage("Far", candles, i);
}

export function isEqual(
  candles: Candle[],
  i: number,
  a: number,
  b: number,
): boolean {
  return Math.abs(a - b) <= candleAverage("Equal", candles, i);
}
