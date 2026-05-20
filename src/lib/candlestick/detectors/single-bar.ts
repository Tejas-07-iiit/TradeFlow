import type { Candle } from "@/types/market";

import {
  bodyMid,
  candleAverage,
  candleColor,
  highLowRange,
  isBlack,
  isBodyLong,
  isBodyShort,
  isBodyVeryLong,
  isDojiBody,
  isEqual,
  isNear,
  isShadowLong,
  isShadowShort,
  isShadowVeryLong,
  isShadowVeryShort,
  isWhite,
  lowerShadow,
  realBody,
  totalShadows,
  upperShadow,
} from "../body-stats";

/**
 * Single-bar TA-Lib CDL detectors. Each function mirrors the upstream
 * algorithm and returns one of {-100, 0, +100} signed strength.
 *
 * Detector contract: callers pass the *entire* candle window and the index
 * of the bar under test (`i`). The detector reads the bar and any prior
 * bars needed for the averaging window — see `body-stats.ts` for how
 * averaging windows are sliced from the prior `period` bars.
 */

// ─── Doji family ────────────────────────────────────────────────────────────

export function cdlDoji(c: Candle[], i: number): number {
  if (i < 11) return 0;
  return isDojiBody(c, i) ? 100 : 0;
}

export function cdlDragonflyDoji(c: Candle[], i: number): number {
  if (i < 11) return 0;
  if (!isDojiBody(c, i)) return 0;
  if (!isShadowVeryShort(c, i, "upper")) return 0;
  if (!isShadowLong(c, i, "lower")) return 0;
  return 100;
}

export function cdlGravestoneDoji(c: Candle[], i: number): number {
  if (i < 11) return 0;
  if (!isDojiBody(c, i)) return 0;
  if (!isShadowVeryShort(c, i, "lower")) return 0;
  if (!isShadowLong(c, i, "upper")) return 0;
  return -100;
}

export function cdlLongLeggedDoji(c: Candle[], i: number): number {
  if (i < 11) return 0;
  if (!isDojiBody(c, i)) return 0;
  // Both shadows long-ish; we lean on TA-Lib's spec: doji body + long upper
  // OR long lower (relaxed from "both long" in TA-Lib's loose form).
  const longUpper = isShadowLong(c, i, "upper");
  const longLower = isShadowLong(c, i, "lower");
  return longUpper && longLower ? 100 : 0;
}

export function cdlRickshawMan(c: Candle[], i: number): number {
  if (i < 11) return 0;
  if (!isDojiBody(c, i)) return 0;
  // Long upper AND long lower shadow, with the body sitting in the middle of
  // the day's range (within `Near` of the midpoint).
  const longUpper = isShadowLong(c, i, "upper");
  const longLower = isShadowLong(c, i, "lower");
  if (!(longUpper && longLower)) return 0;
  const bar = c[i];
  const midRange = (bar.high + bar.low) / 2;
  return isNear(c, i, bodyMid(bar), midRange) ? 100 : 0;
}

// ─── Hammer / Hanging Man / Shooting Star ───────────────────────────────────

export function cdlHammer(c: Candle[], i: number): number {
  if (i < 11) return 0;
  // body short, lower shadow long, upper shadow very short, body in lower
  // half of high-low, must occur after a downtrend (close[i-1] < close[i-2]).
  if (!isBodyShort(c, i)) return 0;
  if (!isShadowLong(c, i, "lower")) return 0;
  if (!isShadowVeryShort(c, i, "upper")) return 0;
  const bar = c[i];
  const lowerHalfMax = bar.low + highLowRange(bar) * 0.5;
  if (Math.min(bar.open, bar.close) < lowerHalfMax === false) return 0;
  // Downtrend confirmation — TA-Lib uses the prior close < the one before it.
  if (i >= 2 && c[i - 1].close >= c[i - 2].close) {
    // Loose mode: still allow if prior bar is bearish.
    if (!isBlack(c[i - 1])) return 0;
  }
  return 100;
}

export function cdlHangingMan(c: Candle[], i: number): number {
  if (i < 11) return 0;
  if (!isBodyShort(c, i)) return 0;
  if (!isShadowLong(c, i, "lower")) return 0;
  if (!isShadowVeryShort(c, i, "upper")) return 0;
  const bar = c[i];
  const lowerHalfMax = bar.low + highLowRange(bar) * 0.5;
  if (Math.min(bar.open, bar.close) < lowerHalfMax === false) return 0;
  // Uptrend confirmation.
  if (i >= 2 && c[i - 1].close <= c[i - 2].close) {
    if (!isWhite(c[i - 1])) return 0;
  }
  return -100;
}

export function cdlInvertedHammer(c: Candle[], i: number): number {
  if (i < 11) return 0;
  if (!isBodyShort(c, i)) return 0;
  if (!isShadowLong(c, i, "upper")) return 0;
  if (!isShadowVeryShort(c, i, "lower")) return 0;
  // After a downtrend.
  if (i >= 1 && c[i - 1].close > c[i].open) return 0;
  return 100;
}

export function cdlShootingStar(c: Candle[], i: number): number {
  if (i < 11) return 0;
  if (!isBodyShort(c, i)) return 0;
  if (!isShadowLong(c, i, "upper")) return 0;
  if (!isShadowVeryShort(c, i, "lower")) return 0;
  // Real body in the lower half — i.e. price closed near the low.
  const bar = c[i];
  const upperHalfMin = bar.low + highLowRange(bar) * 0.5;
  if (Math.max(bar.open, bar.close) > upperHalfMin === false) return 0;
  // Uptrend confirmation: gap up vs prior close OR prior bar white.
  if (i >= 1 && Math.min(bar.open, bar.close) <= c[i - 1].close && !isWhite(c[i - 1])) {
    return 0;
  }
  return -100;
}

export function cdlTakuri(c: Candle[], i: number): number {
  if (i < 11) return 0;
  // Takuri = a dragonfly variant: small body, very short upper shadow,
  // VERY long lower shadow.
  if (!isDojiBody(c, i)) return 0;
  if (!isShadowVeryShort(c, i, "upper")) return 0;
  if (!isShadowVeryLong(c, i, "lower")) return 0;
  return 100;
}

// ─── Marubozu family ───────────────────────────────────────────────────────

export function cdlMarubozu(c: Candle[], i: number): number {
  if (i < 11) return 0;
  if (!isBodyLong(c, i)) return 0;
  if (!isShadowVeryShort(c, i, "upper")) return 0;
  if (!isShadowVeryShort(c, i, "lower")) return 0;
  return candleColor(c[i]) === 1 ? 100 : candleColor(c[i]) === -1 ? -100 : 0;
}

export function cdlClosingMarubozu(c: Candle[], i: number): number {
  if (i < 11) return 0;
  if (!isBodyLong(c, i)) return 0;
  const color = candleColor(c[i]);
  if (color === 0) return 0;
  if (color === 1) {
    // White closing marubozu — closes at the high (no upper shadow).
    return isShadowVeryShort(c, i, "upper") ? 100 : 0;
  }
  return isShadowVeryShort(c, i, "lower") ? -100 : 0;
}

export function cdlLongLine(c: Candle[], i: number): number {
  if (i < 11) return 0;
  if (!isBodyLong(c, i)) return 0;
  // Both shadows short — but not so short as to be a marubozu.
  if (!isShadowShort(c, i, "both")) return 0;
  return candleColor(c[i]) === 1 ? 100 : candleColor(c[i]) === -1 ? -100 : 0;
}

export function cdlShortLine(c: Candle[], i: number): number {
  if (i < 11) return 0;
  if (!isBodyShort(c, i)) return 0;
  if (!isShadowShort(c, i, "both")) return 0;
  return candleColor(c[i]) === 1 ? 100 : candleColor(c[i]) === -1 ? -100 : 0;
}

export function cdlSpinningTop(c: Candle[], i: number): number {
  if (i < 11) return 0;
  if (!isBodyShort(c, i)) return 0;
  // Real body smaller than both shadows.
  const bar = c[i];
  const body = realBody(bar);
  if (upperShadow(bar) <= body) return 0;
  if (lowerShadow(bar) <= body) return 0;
  return candleColor(bar) === 1 ? 100 : candleColor(bar) === -1 ? -100 : 0;
}

export function cdlHighWave(c: Candle[], i: number): number {
  if (i < 11) return 0;
  // Body short, BOTH shadows very long.
  if (!isBodyShort(c, i)) return 0;
  if (!isShadowVeryLong(c, i, "upper")) return 0;
  if (!isShadowVeryLong(c, i, "lower")) return 0;
  return candleColor(c[i]) === 1 ? 100 : candleColor(c[i]) === -1 ? -100 : 0;
}

export function cdlBeltHold(c: Candle[], i: number): number {
  if (i < 11) return 0;
  if (!isBodyLong(c, i)) return 0;
  const bar = c[i];
  const color = candleColor(bar);
  if (color === 0) return 0;
  if (color === 1) {
    // White belt hold: opens at the low (no lower shadow), after a downtrend.
    if (!isShadowVeryShort(c, i, "lower")) return 0;
    if (i >= 1 && c[i - 1].close >= bar.open) return 0;
    return 100;
  }
  // Black belt hold: opens at the high (no upper shadow), after an uptrend.
  if (!isShadowVeryShort(c, i, "upper")) return 0;
  if (i >= 1 && c[i - 1].close <= bar.open) return 0;
  return -100;
}
