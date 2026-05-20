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
  isShadowVeryShort,
  isWhite,
  realBody,
} from "../body-stats";

// ─── Stars ──────────────────────────────────────────────────────────────────

function isMorningStarShape(c: Candle[], i: number, requireDoji: boolean): boolean {
  if (i < 13) return false;
  const a = c[i - 2];
  const b = c[i - 1];
  const cur = c[i];
  // Bar A: long black.
  if (!isBlack(a) || !isBodyLong(c, i - 2)) return false;
  // Bar B: small body (star). Doji form required for the doji variant.
  if (requireDoji) {
    if (!isDojiBody(c, i - 1)) return false;
  } else {
    if (!isBodyShort(c, i - 1)) return false;
  }
  // Gap down between A close and B body's top.
  const bTop = Math.max(b.open, b.close);
  if (!(bTop < a.close)) return false;
  // Bar C: white, closes well into A's body.
  if (!isWhite(cur)) return false;
  if (!isBodyLong(c, i)) return false;
  if (!(cur.close > bodyMid(a))) return false;
  return true;
}

function isEveningStarShape(c: Candle[], i: number, requireDoji: boolean): boolean {
  if (i < 13) return false;
  const a = c[i - 2];
  const b = c[i - 1];
  const cur = c[i];
  if (!isWhite(a) || !isBodyLong(c, i - 2)) return false;
  if (requireDoji) {
    if (!isDojiBody(c, i - 1)) return false;
  } else {
    if (!isBodyShort(c, i - 1)) return false;
  }
  const bBot = Math.min(b.open, b.close);
  if (!(bBot > a.close)) return false;
  if (!isBlack(cur)) return false;
  if (!isBodyLong(c, i)) return false;
  if (!(cur.close < bodyMid(a))) return false;
  return true;
}

export function cdlMorningStar(c: Candle[], i: number): number {
  return isMorningStarShape(c, i, false) ? 100 : 0;
}

export function cdlMorningDojiStar(c: Candle[], i: number): number {
  return isMorningStarShape(c, i, true) ? 100 : 0;
}

export function cdlEveningStar(c: Candle[], i: number): number {
  return isEveningStarShape(c, i, false) ? -100 : 0;
}

export function cdlEveningDojiStar(c: Candle[], i: number): number {
  return isEveningStarShape(c, i, true) ? -100 : 0;
}

export function cdlDojiStar(c: Candle[], i: number): number {
  if (i < 12) return 0;
  const prev = c[i - 1];
  const cur = c[i];
  if (!isBodyLong(c, i - 1)) return 0;
  if (!isDojiBody(c, i)) return 0;
  // Gap between bodies in the direction of the prior bar.
  if (isWhite(prev) && Math.min(cur.open, cur.close) > prev.close) return -100;
  if (isBlack(prev) && Math.max(cur.open, cur.close) < prev.close) return 100;
  return 0;
}

// ─── Three Soldiers / Three Crows ───────────────────────────────────────────

export function cdl3WhiteSoldiers(c: Candle[], i: number): number {
  if (i < 13) return 0;
  const a = c[i - 2];
  const b = c[i - 1];
  const cur = c[i];
  if (!(isWhite(a) && isWhite(b) && isWhite(cur))) return 0;
  if (!(isBodyLong(c, i - 2) && isBodyLong(c, i - 1) && isBodyLong(c, i))) return 0;
  // Each opens within prior body (open[i] >= open[i-1] and <= close[i-1]).
  if (!(b.open > a.open && b.open <= a.close)) return 0;
  if (!(cur.open > b.open && cur.open <= b.close)) return 0;
  // Each closes higher.
  if (!(b.close > a.close && cur.close > b.close)) return 0;
  // Short upper shadows.
  if (!isShadowVeryShort(c, i - 2, "upper")) return 0;
  if (!isShadowVeryShort(c, i - 1, "upper")) return 0;
  if (!isShadowVeryShort(c, i, "upper")) return 0;
  return 100;
}

export function cdl3BlackCrows(c: Candle[], i: number): number {
  if (i < 13) return 0;
  const a = c[i - 2];
  const b = c[i - 1];
  const cur = c[i];
  if (!(isBlack(a) && isBlack(b) && isBlack(cur))) return 0;
  if (!(isBodyLong(c, i - 2) && isBodyLong(c, i - 1) && isBodyLong(c, i))) return 0;
  // Each opens within prior body.
  if (!(b.open < a.open && b.open >= a.close)) return 0;
  if (!(cur.open < b.open && cur.open >= b.close)) return 0;
  if (!(b.close < a.close && cur.close < b.close)) return 0;
  if (!isShadowVeryShort(c, i - 2, "lower")) return 0;
  if (!isShadowVeryShort(c, i - 1, "lower")) return 0;
  if (!isShadowVeryShort(c, i, "lower")) return 0;
  return -100;
}

export function cdlIdentical3Crows(c: Candle[], i: number): number {
  if (i < 13) return 0;
  const a = c[i - 2];
  const b = c[i - 1];
  const cur = c[i];
  if (!(isBlack(a) && isBlack(b) && isBlack(cur))) return 0;
  if (!(isBodyLong(c, i - 2) && isBodyLong(c, i - 1) && isBodyLong(c, i))) return 0;
  // Each opens AT the prior close (identical).
  if (!isEqual(c, i, b.open, a.close)) return 0;
  if (!isEqual(c, i, cur.open, b.close)) return 0;
  if (!(b.close < a.close && cur.close < b.close)) return 0;
  return -100;
}

// ─── Three Inside / Three Outside ──────────────────────────────────────────

export function cdl3Inside(c: Candle[], i: number): number {
  if (i < 13) return 0;
  // Three Inside Up/Down = Harami + confirmation bar.
  const a = c[i - 2];
  const b = c[i - 1];
  const cur = c[i];
  const prevTop = Math.max(a.open, a.close);
  const prevBot = Math.min(a.open, a.close);
  const bTop = Math.max(b.open, b.close);
  const bBot = Math.min(b.open, b.close);
  if (!isBodyLong(c, i - 2)) return 0;
  if (!isBodyShort(c, i - 1)) return 0;
  if (!(bTop <= prevTop && bBot >= prevBot)) return 0;
  if (isBlack(a) && isWhite(b) && isWhite(cur) && cur.close > a.open) return 100;
  if (isWhite(a) && isBlack(b) && isBlack(cur) && cur.close < a.open) return -100;
  return 0;
}

export function cdl3Outside(c: Candle[], i: number): number {
  if (i < 13) return 0;
  // Three Outside = Engulfing + confirmation bar.
  const a = c[i - 2];
  const b = c[i - 1];
  const cur = c[i];
  if (isBlack(a) && isWhite(b) && b.close > a.open && b.open < a.close) {
    // Bullish outside; confirm with a higher-closing third.
    if (isWhite(cur) && cur.close > b.close) return 100;
  }
  if (isWhite(a) && isBlack(b) && b.open > a.close && b.close < a.open) {
    if (isBlack(cur) && cur.close < b.close) return -100;
  }
  return 0;
}

// ─── Three-Line Strike / Tristar ───────────────────────────────────────────

export function cdl3LineStrike(c: Candle[], i: number): number {
  if (i < 14) return 0;
  const a = c[i - 3];
  const b = c[i - 2];
  const cc = c[i - 1];
  const d = c[i];
  // Three same-coloured trending bars + opposing bar that engulfs all three.
  if (isWhite(a) && isWhite(b) && isWhite(cc)) {
    if (!(b.close > a.close && cc.close > b.close)) return 0;
    if (!isBlack(d)) return 0;
    if (!(d.open > cc.close && d.close < a.open)) return 0;
    return -100; // bearish three-line strike (contrarian continuation upward)
  }
  if (isBlack(a) && isBlack(b) && isBlack(cc)) {
    if (!(b.close < a.close && cc.close < b.close)) return 0;
    if (!isWhite(d)) return 0;
    if (!(d.open < cc.close && d.close > a.open)) return 0;
    return 100;
  }
  return 0;
}

export function cdlTristar(c: Candle[], i: number): number {
  if (i < 13) return 0;
  if (!(isDojiBody(c, i - 2) && isDojiBody(c, i - 1) && isDojiBody(c, i))) return 0;
  const a = c[i - 2];
  const b = c[i - 1];
  const cur = c[i];
  // Middle doji must gap from the other two.
  const aMid = bodyMid(a);
  const bMid = bodyMid(b);
  const curMid = bodyMid(cur);
  // Bullish tristar — middle doji below.
  if (bMid < aMid && bMid < curMid) return 100;
  // Bearish tristar — middle doji above.
  if (bMid > aMid && bMid > curMid) return -100;
  return 0;
}

// ─── Two Crows / Upside Gap Two Crows ──────────────────────────────────────

export function cdl2Crows(c: Candle[], i: number): number {
  if (i < 13) return 0;
  const a = c[i - 2];
  const b = c[i - 1];
  const cur = c[i];
  if (!isWhite(a) || !isBodyLong(c, i - 2)) return 0;
  if (!isBlack(b)) return 0;
  if (!isBlack(cur)) return 0;
  // Gap up between A close and B body bottom.
  const bBot = Math.min(b.open, b.close);
  if (!(bBot > a.close)) return 0;
  // Current opens inside B body, closes inside A body.
  if (!(cur.open < b.open && cur.open > b.close)) return 0;
  if (!(cur.close > a.open && cur.close < a.close)) return 0;
  return -100;
}

export function cdlUpsideGap2Crows(c: Candle[], i: number): number {
  if (i < 13) return 0;
  const a = c[i - 2];
  const b = c[i - 1];
  const cur = c[i];
  if (!isWhite(a) || !isBodyLong(c, i - 2)) return 0;
  if (!isBlack(b) || !isBodyShort(c, i - 1)) return 0;
  if (!isBlack(cur)) return 0;
  // Gap between A and B (B body's bottom above A close).
  const bBot = Math.min(b.open, b.close);
  if (!(bBot > a.close)) return 0;
  // Current engulfs B body and closes above A close.
  if (!(cur.open > b.open && cur.close < b.close)) return 0;
  if (!(cur.close > a.close)) return 0;
  return -100;
}

// ─── Abandoned Baby ─────────────────────────────────────────────────────────

export function cdlAbandonedBaby(c: Candle[], i: number): number {
  if (i < 13) return 0;
  const a = c[i - 2];
  const b = c[i - 1];
  const cur = c[i];
  if (!isDojiBody(c, i - 1)) return 0;
  // Bullish: A black long, doji gaps down from A AND C (gap between shadows too).
  if (isBlack(a) && isBodyLong(c, i - 2)) {
    if (!(b.high < a.low)) return 0;
    if (!isWhite(cur) || !isBodyLong(c, i)) return 0;
    if (!(cur.low > b.high)) return 0;
    return 100;
  }
  if (isWhite(a) && isBodyLong(c, i - 2)) {
    if (!(b.low > a.high)) return 0;
    if (!isBlack(cur) || !isBodyLong(c, i)) return 0;
    if (!(cur.high < b.low)) return 0;
    return -100;
  }
  return 0;
}

// ─── Advance Block / Stalled ───────────────────────────────────────────────

export function cdlAdvanceBlock(c: Candle[], i: number): number {
  if (i < 13) return 0;
  const a = c[i - 2];
  const b = c[i - 1];
  const cur = c[i];
  if (!(isWhite(a) && isWhite(b) && isWhite(cur))) return 0;
  if (!(b.close > a.close && cur.close > b.close)) return 0;
  // Bodies progressively shorter.
  if (!(realBody(b) < realBody(a) && realBody(cur) < realBody(b))) return 0;
  // Upper shadows getting longer (sign of stalling).
  if (!((c[i].high - cur.close) > (c[i - 1].high - b.close))) return 0;
  return -100;
}

export function cdlStalledPattern(c: Candle[], i: number): number {
  if (i < 13) return 0;
  const a = c[i - 2];
  const b = c[i - 1];
  const cur = c[i];
  if (!(isWhite(a) && isWhite(b) && isWhite(cur))) return 0;
  if (!(isBodyLong(c, i - 2) && isBodyLong(c, i - 1))) return 0;
  if (!isBodyShort(c, i)) return 0;
  if (!(b.close > a.close)) return 0;
  // Third small body sits near top of second body.
  if (!(cur.open > bodyMid(b) && cur.open <= b.close + (b.close - b.open) * 0.3)) return 0;
  return -100;
}

// ─── 3 Stars in the South ──────────────────────────────────────────────────

export function cdl3StarsInSouth(c: Candle[], i: number): number {
  if (i < 13) return 0;
  const a = c[i - 2];
  const b = c[i - 1];
  const cur = c[i];
  if (!(isBlack(a) && isBlack(b) && isBlack(cur))) return 0;
  // Bar A: long body with long lower shadow.
  if (!isBodyLong(c, i - 2)) return 0;
  if (!((a.high - Math.max(a.open, a.close)) < realBody(a) * 0.5)) return 0;
  if (!((Math.min(a.open, a.close) - a.low) > realBody(a))) return 0;
  // Bar B: similar but smaller; low above A's low.
  if (!isBodyShort(c, i - 1) || !(b.low > a.low) || !(b.low < a.high)) return 0;
  // Bar C: short marubozu (no shadows); high below B high, low above A low.
  if (!isBodyShort(c, i)) return 0;
  if (!(cur.high < b.high) || !(cur.low > b.low && cur.low > a.low)) return 0;
  return 100;
}

// ─── Stick Sandwich ────────────────────────────────────────────────────────

export function cdlStickSandwich(c: Candle[], i: number): number {
  if (i < 13) return 0;
  const a = c[i - 2];
  const b = c[i - 1];
  const cur = c[i];
  if (!isBlack(a) || !isWhite(b) || !isBlack(cur)) return 0;
  // Closes of A and C equal-ish.
  if (!isEqual(c, i, a.close, cur.close)) return 0;
  // Middle bar fully above A close.
  if (!(b.low > a.close)) return 0;
  return 100;
}

// ─── Tasuki Gap / Side-by-Side White / Unique 3 River ──────────────────────

export function cdlTasukiGap(c: Candle[], i: number): number {
  if (i < 13) return 0;
  const a = c[i - 2];
  const b = c[i - 1];
  const cur = c[i];
  // Bullish tasuki: A white, gap up, B white, C black filling part of gap.
  if (isWhite(a) && isWhite(b) && b.open > a.close && b.close > a.high) {
    if (!isBlack(cur)) return 0;
    if (!(cur.open > b.close && cur.open < b.open)) return 0;
    if (!(cur.close < b.open && cur.close > a.close)) return 0;
    return 100;
  }
  if (isBlack(a) && isBlack(b) && b.open < a.close && b.close < a.low) {
    if (!isWhite(cur)) return 0;
    if (!(cur.open < b.close && cur.open > b.open)) return 0;
    if (!(cur.close > b.open && cur.close < a.close)) return 0;
    return -100;
  }
  return 0;
}

export function cdlGapSideSideWhite(c: Candle[], i: number): number {
  if (i < 13) return 0;
  const a = c[i - 2];
  const b = c[i - 1];
  const cur = c[i];
  if (!(isWhite(b) && isWhite(cur))) return 0;
  if (!isEqual(c, i, realBody(b), realBody(cur))) return 0;
  if (!isEqual(c, i, b.open, cur.open)) return 0;
  if (isWhite(a) && b.open > a.high) return 100;
  if (isBlack(a) && b.open < a.low) return -100;
  return 0;
}

export function cdlUnique3River(c: Candle[], i: number): number {
  if (i < 13) return 0;
  const a = c[i - 2];
  const b = c[i - 1];
  const cur = c[i];
  if (!isBlack(a) || !isBodyLong(c, i - 2)) return 0;
  if (!isBlack(b) || !isBodyShort(c, i - 1)) return 0;
  // B's low BELOW A's low (river bottom).
  if (!(b.low < a.low)) return 0;
  // B's close above A's close.
  if (!(b.close > a.close)) return 0;
  if (!isWhite(cur) || !isBodyShort(c, i)) return 0;
  // C's open below B's close; C's close below B's close.
  if (!(cur.open < b.close && cur.close < b.close)) return 0;
  return 100;
}
