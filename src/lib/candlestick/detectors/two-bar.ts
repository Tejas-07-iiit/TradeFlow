import type { Candle } from "@/types/market";

import {
  bodyMid,
  candleColor,
  isBlack,
  isBodyLong,
  isBodyShort,
  isBodyVeryLong,
  isDojiBody,
  isEqual,
  isNear,
  isWhite,
  realBody,
} from "../body-stats";

/**
 * Two-bar TA-Lib CDL detectors. Same return contract as the single-bar
 * detectors: { -100, 0, +100 } signed strength.
 */

// ─── Engulfing / Harami / Harami Cross ─────────────────────────────────────

export function cdlEngulfing(c: Candle[], i: number): number {
  if (i < 12) return 0;
  const prev = c[i - 1];
  const cur = c[i];
  // Bullish: prev black, cur white, cur body engulfs prev body.
  if (isBlack(prev) && isWhite(cur) && cur.close > prev.open && cur.open < prev.close) {
    return 100;
  }
  // Bearish: prev white, cur black, cur body engulfs prev body.
  if (isWhite(prev) && isBlack(cur) && cur.open > prev.close && cur.close < prev.open) {
    return -100;
  }
  return 0;
}

export function cdlHarami(c: Candle[], i: number): number {
  if (i < 12) return 0;
  const prev = c[i - 1];
  const cur = c[i];
  if (!isBodyLong(c, i - 1)) return 0;
  if (!isBodyShort(c, i)) return 0;
  const prevTop = Math.max(prev.open, prev.close);
  const prevBot = Math.min(prev.open, prev.close);
  const curTop = Math.max(cur.open, cur.close);
  const curBot = Math.min(cur.open, cur.close);
  if (!(curTop <= prevTop && curBot >= prevBot)) return 0;
  // Bullish harami: prev black, cur white.
  if (isBlack(prev) && isWhite(cur)) return 100;
  // Bearish harami: prev white, cur black.
  if (isWhite(prev) && isBlack(cur)) return -100;
  return 0;
}

export function cdlHaramiCross(c: Candle[], i: number): number {
  if (i < 12) return 0;
  const prev = c[i - 1];
  const cur = c[i];
  if (!isBodyLong(c, i - 1)) return 0;
  if (!isDojiBody(c, i)) return 0;
  const prevTop = Math.max(prev.open, prev.close);
  const prevBot = Math.min(prev.open, prev.close);
  const curTop = Math.max(cur.open, cur.close);
  const curBot = Math.min(cur.open, cur.close);
  if (!(curTop <= prevTop && curBot >= prevBot)) return 0;
  if (isBlack(prev)) return 100;
  if (isWhite(prev)) return -100;
  return 0;
}

// ─── Piercing / Dark Cloud Cover ───────────────────────────────────────────

export function cdlPiercing(c: Candle[], i: number): number {
  if (i < 12) return 0;
  const prev = c[i - 1];
  const cur = c[i];
  if (!isBodyLong(c, i - 1) || !isBlack(prev)) return 0;
  if (!isBodyLong(c, i) || !isWhite(cur)) return 0;
  // Open below prior low, close above the midpoint of prior body.
  if (!(cur.open < prev.low)) return 0;
  if (!(cur.close > bodyMid(prev) && cur.close < prev.open)) return 0;
  return 100;
}

export function cdlDarkCloudCover(c: Candle[], i: number): number {
  if (i < 12) return 0;
  const prev = c[i - 1];
  const cur = c[i];
  if (!isBodyLong(c, i - 1) || !isWhite(prev)) return 0;
  if (!isBodyLong(c, i) || !isBlack(cur)) return 0;
  // Open above prior high, close below the midpoint of prior body.
  if (!(cur.open > prev.high)) return 0;
  if (!(cur.close < bodyMid(prev) && cur.close > prev.open)) return 0;
  return -100;
}

// ─── Counterattack / Homing Pigeon / On-Neck / In-Neck / Thrusting ─────────

export function cdlCounterattack(c: Candle[], i: number): number {
  if (i < 12) return 0;
  const prev = c[i - 1];
  const cur = c[i];
  if (!isBodyLong(c, i - 1) || !isBodyLong(c, i)) return 0;
  // Closes equal-ish; opposite colours.
  if (!isEqual(c, i, prev.close, cur.close)) return 0;
  if (isBlack(prev) && isWhite(cur)) return 100;
  if (isWhite(prev) && isBlack(cur)) return -100;
  return 0;
}

export function cdlHomingPigeon(c: Candle[], i: number): number {
  if (i < 12) return 0;
  const prev = c[i - 1];
  const cur = c[i];
  if (!isBlack(prev) || !isBlack(cur)) return 0;
  if (!isBodyLong(c, i - 1) || !isBodyShort(c, i)) return 0;
  // Second body inside first body.
  if (!(cur.open < prev.open && cur.close > prev.close)) return 0;
  return 100;
}

export function cdlOnNeck(c: Candle[], i: number): number {
  if (i < 12) return 0;
  const prev = c[i - 1];
  const cur = c[i];
  if (!isBlack(prev) || !isWhite(cur)) return 0;
  if (!isBodyLong(c, i - 1)) return 0;
  // Open below prior low; close ≈ prior low.
  if (!(cur.open < prev.low)) return 0;
  if (!isEqual(c, i, cur.close, prev.low)) return 0;
  return -100;
}

export function cdlInNeck(c: Candle[], i: number): number {
  if (i < 12) return 0;
  const prev = c[i - 1];
  const cur = c[i];
  if (!isBlack(prev) || !isWhite(cur)) return 0;
  if (!isBodyLong(c, i - 1)) return 0;
  if (!(cur.open < prev.low)) return 0;
  // Close slightly *inside* prior body but below its midpoint.
  if (!(cur.close >= prev.close && cur.close < prev.close + (prev.open - prev.close) * 0.1)) {
    return 0;
  }
  return -100;
}

export function cdlThrusting(c: Candle[], i: number): number {
  if (i < 12) return 0;
  const prev = c[i - 1];
  const cur = c[i];
  if (!isBlack(prev) || !isWhite(cur)) return 0;
  if (!isBodyLong(c, i - 1) || !isBodyLong(c, i)) return 0;
  if (!(cur.open < prev.low)) return 0;
  // Closes above prior close but below prior body midpoint.
  if (!(cur.close > prev.close && cur.close < bodyMid(prev))) return 0;
  return -100;
}

// ─── Kicking / Matching Low / Separating Lines ────────────────────────────

export function cdlKicking(c: Candle[], i: number): number {
  if (i < 12) return 0;
  const prev = c[i - 1];
  const cur = c[i];
  // Both marubozu, opposite colours, with a gap between them.
  const prevMaru =
    isBodyLong(c, i - 1) &&
    Math.abs(prev.high - Math.max(prev.open, prev.close)) <
      0.05 * realBody(prev) &&
    Math.abs(Math.min(prev.open, prev.close) - prev.low) < 0.05 * realBody(prev);
  const curMaru =
    isBodyLong(c, i) &&
    Math.abs(cur.high - Math.max(cur.open, cur.close)) < 0.05 * realBody(cur) &&
    Math.abs(Math.min(cur.open, cur.close) - cur.low) < 0.05 * realBody(cur);
  if (!prevMaru || !curMaru) return 0;
  if (isBlack(prev) && isWhite(cur) && cur.low > prev.high) return 100;
  if (isWhite(prev) && isBlack(cur) && cur.high < prev.low) return -100;
  return 0;
}

export function cdlKickingByLength(c: Candle[], i: number): number {
  const kick = cdlKicking(c, i);
  if (kick === 0) return 0;
  // TA-Lib variant: direction inherited from the LONGER of the two bodies.
  const longerIsCurrent = realBody(c[i]) > realBody(c[i - 1]);
  if (longerIsCurrent) return kick;
  return -kick;
}

export function cdlMatchingLow(c: Candle[], i: number): number {
  if (i < 12) return 0;
  const prev = c[i - 1];
  const cur = c[i];
  if (!isBlack(prev) || !isBlack(cur)) return 0;
  if (!isBodyLong(c, i - 1)) return 0;
  // Both closes equal-ish.
  if (!isEqual(c, i, prev.close, cur.close)) return 0;
  return 100;
}

export function cdlSeparatingLines(c: Candle[], i: number): number {
  if (i < 12) return 0;
  const prev = c[i - 1];
  const cur = c[i];
  if (candleColor(prev) === candleColor(cur)) return 0;
  if (!isBodyLong(c, i)) return 0;
  // Opens equal-ish; colour same as prior trend bar (continuation).
  if (!isEqual(c, i, prev.open, cur.open)) return 0;
  // Direction = direction of current bar (since it's the continuation bar).
  return candleColor(cur) === 1 ? 100 : -100;
}

// Re-export needed in three/multi files.
export { isBodyVeryLong, isNear };
