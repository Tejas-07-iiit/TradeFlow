import type { Candle } from "@/types/market";

import {
  bodyMid,
  candleAverage,
  candleColor,
  isBlack,
  isBodyLong,
  isBodyShort,
  isDojiBody,
  isEqual,
  isNear,
  isShadowVeryShort,
  isWhite,
  lowerShadow,
  realBody,
  upperShadow,
} from "../body-stats";

// ─── Hikkake / Modified Hikkake ────────────────────────────────────────────

export function cdlHikkake(c: Candle[], i: number): number {
  if (i < 4) return 0;
  // Bars: i-3 (range), i-2 (inside), i-1 (false breakout), i (confirmation).
  const a = c[i - 3];
  const b = c[i - 2];
  const cc = c[i - 1];
  const d = c[i];
  // b inside a (lower high, higher low).
  if (!(b.high < a.high && b.low > a.low)) return 0;
  // c is a false breakout: higher high & higher low (bull trap) OR lower
  // high & lower low (bear trap).
  if (cc.high > b.high && cc.low > b.low) {
    // Bull trap setup → bearish confirmation: d closes below the b low.
    if (d.close < b.low) return -100;
  } else if (cc.high < b.high && cc.low < b.low) {
    // Bear trap → bullish confirmation: d closes above the b high.
    if (d.close > b.high) return 100;
  }
  return 0;
}

export function cdlHikkakeMod(c: Candle[], i: number): number {
  if (i < 6) return 0;
  // Modified hikkake adds a context bar before the inside bar.
  // Bars: i-5 (context), i-4 (range), i-3 (inside), i-2 (false breakout),
  //       i-1 (confirmation), i (extra confirmation that strengthens signal).
  const r = c[i - 4];
  const inside = c[i - 3];
  const fake = c[i - 2];
  const conf = c[i - 1];
  if (!(inside.high < r.high && inside.low > r.low)) return 0;
  // Direction set by context bar relative to the range.
  if (fake.high > inside.high && fake.low > inside.low && conf.close < inside.low) {
    if (c[i - 5].close < r.close) return -100;
  }
  if (fake.high < inside.high && fake.low < inside.low && conf.close > inside.high) {
    if (c[i - 5].close > r.close) return 100;
  }
  return 0;
}

// ─── Mat Hold / Rise-Fall 3 Methods ────────────────────────────────────────

export function cdlMatHold(c: Candle[], i: number): number {
  if (i < 15) return 0;
  // 5 bars: long white, gap up small black, two small consolidations,
  // long white closing above bar 0 high.
  const a = c[i - 4];
  const b = c[i - 3];
  const cc = c[i - 2];
  const d = c[i - 1];
  const e = c[i];
  if (!isWhite(a) || !isBodyLong(c, i - 4)) return 0;
  if (!isBlack(b) || !isBodyShort(c, i - 3)) return 0;
  // Gap up between A close and B body.
  if (!(Math.min(b.open, b.close) > a.close)) return 0;
  // Bars C & D: small, drifting lower but staying above A close.
  if (!isBodyShort(c, i - 2) || !isBodyShort(c, i - 1)) return 0;
  if (Math.min(cc.open, cc.close) < a.close) return 0;
  if (Math.min(d.open, d.close) < a.close) return 0;
  // Bar E: long white, closes above b high.
  if (!isWhite(e) || !isBodyLong(c, i)) return 0;
  if (!(e.close > b.high)) return 0;
  return 100;
}

export function cdlRiseFall3Methods(c: Candle[], i: number): number {
  if (i < 14) return 0;
  // 5 bars; bullish: long white, three small bears inside, long white closing
  // above bar 0 high. Bearish: long black, three small bulls inside, long
  // black closing below bar 0 low.
  const a = c[i - 4];
  const b = c[i - 3];
  const cc = c[i - 2];
  const d = c[i - 1];
  const e = c[i];
  const small = (idx: number) => isBodyShort(c, idx);

  if (
    isWhite(a) && isBodyLong(c, i - 4) &&
    isBlack(b) && small(i - 3) &&
    isBlack(cc) && small(i - 2) &&
    isBlack(d) && small(i - 1) &&
    isWhite(e) && isBodyLong(c, i)
  ) {
    // Three middle bars stay within A range.
    if (b.high <= a.high && b.low >= a.low &&
        cc.high <= a.high && cc.low >= a.low &&
        d.high <= a.high && d.low >= a.low &&
        e.close > a.close) {
      return 100;
    }
  }

  if (
    isBlack(a) && isBodyLong(c, i - 4) &&
    isWhite(b) && small(i - 3) &&
    isWhite(cc) && small(i - 2) &&
    isWhite(d) && small(i - 1) &&
    isBlack(e) && isBodyLong(c, i)
  ) {
    if (b.high <= a.high && b.low >= a.low &&
        cc.high <= a.high && cc.low >= a.low &&
        d.high <= a.high && d.low >= a.low &&
        e.close < a.close) {
      return -100;
    }
  }
  return 0;
}

export function cdlXSideGap3Methods(c: Candle[], i: number): number {
  if (i < 13) return 0;
  // Three bars: gap1 (same colour), gap2 (same colour), gap3 fills the gap.
  const a = c[i - 2];
  const b = c[i - 1];
  const cur = c[i];
  // Bullish: A & B white with gap up between them, C black opens inside B
  // body and closes inside the gap.
  if (isWhite(a) && isWhite(b) && b.open > a.high) {
    if (!isBlack(cur)) return 0;
    if (!(cur.open > b.open && cur.open < b.close)) return 0;
    if (!(cur.close > a.close && cur.close < b.open)) return 0;
    return 100;
  }
  if (isBlack(a) && isBlack(b) && b.open < a.low) {
    if (!isWhite(cur)) return 0;
    if (!(cur.open < b.open && cur.open > b.close)) return 0;
    if (!(cur.close < a.close && cur.close > b.open)) return 0;
    return -100;
  }
  return 0;
}

// ─── Concealing Baby Swallow / Ladder Bottom / Breakaway ──────────────────

export function cdlConcealBabySwall(c: Candle[], i: number): number {
  if (i < 14) return 0;
  // 4 black bars; first two are marubozu, third opens with gap down but has
  // an upper shadow into the prior body, fourth engulfs the third entirely.
  const a = c[i - 3];
  const b = c[i - 2];
  const cc = c[i - 1];
  const d = c[i];
  if (!(isBlack(a) && isBlack(b) && isBlack(cc) && isBlack(d))) return 0;
  if (!isShadowVeryShort(c, i - 3, "upper") || !isShadowVeryShort(c, i - 3, "lower")) return 0;
  if (!isShadowVeryShort(c, i - 2, "upper") || !isShadowVeryShort(c, i - 2, "lower")) return 0;
  // C: gap down vs B; upper shadow extends into B body.
  if (!(cc.open < b.close)) return 0;
  if (!(cc.high > b.close)) return 0;
  // D engulfs C entirely (high > C high, low < C low).
  if (!(d.high > cc.high && d.low < cc.low)) return 0;
  return 100;
}

export function cdlLadderBottom(c: Candle[], i: number): number {
  if (i < 15) return 0;
  // 5 bars: 3 consecutive long blacks with declining opens & closes,
  // 4th black with upper shadow, 5th white opens above 4th body.
  const a = c[i - 4];
  const b = c[i - 3];
  const cc = c[i - 2];
  const d = c[i - 1];
  const e = c[i];
  if (!(isBlack(a) && isBlack(b) && isBlack(cc) && isBlack(d) && isWhite(e))) return 0;
  if (!(a.open > b.open && b.open > cc.open)) return 0;
  if (!(a.close > b.close && b.close > cc.close)) return 0;
  // D has noticeable upper shadow.
  if (!(upperShadow(d) > candleAverage("ShadowShort", c, i - 1))) return 0;
  if (!(e.open > Math.max(d.open, d.close))) return 0;
  return 100;
}

export function cdlBreakaway(c: Candle[], i: number): number {
  if (i < 15) return 0;
  const a = c[i - 4];
  const b = c[i - 3];
  const cc = c[i - 2];
  const d = c[i - 1];
  const e = c[i];
  // Bullish breakaway: long black, small black gapping down, then 2 small
  // blacks continuing down, fifth bar long white closing inside the gap.
  if (isBlack(a) && isBodyLong(c, i - 4)) {
    if (!isBlack(b) || !isBodyShort(c, i - 3)) return 0;
    if (!(b.open < a.close)) return 0;
    if (!(cc.close < b.close && d.close < cc.close)) return 0;
    if (!isWhite(e) || !isBodyLong(c, i)) return 0;
    if (!(e.close < a.open && e.close > b.open)) return 0;
    return 100;
  }
  if (isWhite(a) && isBodyLong(c, i - 4)) {
    if (!isWhite(b) || !isBodyShort(c, i - 3)) return 0;
    if (!(b.open > a.close)) return 0;
    if (!(cc.close > b.close && d.close > cc.close)) return 0;
    if (!isBlack(e) || !isBodyLong(c, i)) return 0;
    if (!(e.close > a.open && e.close < b.open)) return 0;
    return -100;
  }
  return 0;
}
