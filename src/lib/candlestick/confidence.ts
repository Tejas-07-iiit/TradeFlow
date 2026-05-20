import type { Candle, Timeframe } from "@/types/market";

import { ema, lastNumber, rsi, vwap } from "@/lib/indicators/calculations";

import type {
  ConfidenceBreakdown,
  PatternCategory,
  PatternDirection,
  RawDetection,
  ScoredDetection,
} from "./types";

/**
 * Confirmation context the confidence engine reads. The strategy framework
 * already computes most of these on every tick — `runEngine` re-uses them
 * when available; the local helpers below recompute on demand for ad-hoc
 * callers (e.g. the client-side overlay hook).
 */
export interface ConfirmationContext {
  candles: Candle[];
  /** Index of the bar whose detection is being scored — usually `candles.length-1`. */
  barIndex: number;
  ema50?: number | null;
  ema200?: number | null;
  rsi14?: number | null;
  adx14?: number | null;
  atrPct?: number | null;
  vwap?: number | null;
  /** Regime label from the strategy framework's classifier. */
  regime?: string;
  /** Same-direction detection on a higher TF within the recent window? */
  higherTimeframeAgrees?: boolean;
}

/**
 * Score a single raw detection against the confirmation context.
 *
 * The math is intentionally additive and bounded — each contributor adds /
 * subtracts up to a fixed cap, then the total is clamped to [0..100]. That
 * structure keeps the breakdown auditable (every line item is independent)
 * and makes it impossible for one runaway contributor to override the rest.
 */
export function scoreDetection(
  raw: RawDetection,
  ctx: ConfirmationContext,
  timeframe: Timeframe,
  reliability: number,
): ScoredDetection {
  const bar = ctx.candles[ctx.barIndex];
  const base = Math.round(40 + reliability * 30); // 40-70 starting band

  // ─── Trend alignment ───────────────────────────────────────────────────
  let trendAlignment: ScoredDetection["trendAlignment"] = "neutral";
  let trendDelta = 0;
  if (ctx.ema50 != null && ctx.ema200 != null) {
    const stackBull = ctx.ema50 > ctx.ema200;
    if (raw.direction === "bullish" && stackBull) {
      // Reversals fight the trend, continuation/momentum confirms it.
      trendAlignment = isReversal(raw.category) ? "against" : "with";
    } else if (raw.direction === "bearish" && !stackBull) {
      trendAlignment = isReversal(raw.category) ? "against" : "with";
    } else if (raw.direction !== "neutral") {
      trendAlignment = isReversal(raw.category) ? "with" : "against";
    }
    trendDelta = trendAlignment === "with" ? 10 : trendAlignment === "against" ? -8 : 0;
  }

  // ─── Volume confirmation ───────────────────────────────────────────────
  const volumeMean = rollingMean(
    ctx.candles.slice(Math.max(0, ctx.barIndex - 20), ctx.barIndex),
    (c) => c.volume,
  );
  let volumeConfirmation: ScoredDetection["volumeConfirmation"] = "absent";
  let volumeDelta = 0;
  if (volumeMean > 0) {
    const ratio = bar.volume / volumeMean;
    if (ratio >= 1.5) {
      volumeConfirmation = "confirmed";
      volumeDelta = 9;
    } else if (ratio >= 1.0) {
      volumeConfirmation = "weak";
      volumeDelta = 3;
    } else {
      volumeDelta = -3;
    }
  }

  // ─── RSI confirmation ──────────────────────────────────────────────────
  let rsiDelta = 0;
  if (ctx.rsi14 != null) {
    if (raw.direction === "bullish" && ctx.rsi14 < 35) rsiDelta = 8;
    if (raw.direction === "bullish" && ctx.rsi14 > 70) rsiDelta = -6;
    if (raw.direction === "bearish" && ctx.rsi14 > 65) rsiDelta = 8;
    if (raw.direction === "bearish" && ctx.rsi14 < 30) rsiDelta = -6;
  }

  // ─── EMA confirmation (close vs EMA50) ─────────────────────────────────
  let emaDelta = 0;
  if (ctx.ema50 != null) {
    if (raw.direction === "bullish" && bar.close > ctx.ema50) emaDelta = 4;
    if (raw.direction === "bearish" && bar.close < ctx.ema50) emaDelta = 4;
  }

  // ─── VWAP confirmation ─────────────────────────────────────────────────
  let vwapDelta = 0;
  if (ctx.vwap != null) {
    if (raw.direction === "bullish" && bar.close > ctx.vwap) vwapDelta = 4;
    if (raw.direction === "bearish" && bar.close < ctx.vwap) vwapDelta = 4;
  }

  // ─── Higher-timeframe alignment ────────────────────────────────────────
  const htfDelta = ctx.higherTimeframeAgrees ? 8 : 0;

  // ─── ADX boost (continuation/breakout patterns love high ADX) ──────────
  let adxBoost = 0;
  if (ctx.adx14 != null) {
    if (raw.category === "Continuation" || raw.category === "Breakout Confirmation" || raw.category === "Momentum") {
      if (ctx.adx14 >= 25) adxBoost = 8;
      else if (ctx.adx14 < 15) adxBoost = -5;
    } else if (isReversal(raw.category)) {
      // Reversals work best when ADX is cooling.
      if (ctx.adx14 < 22) adxBoost = 5;
      else if (ctx.adx14 >= 35) adxBoost = -6;
    }
  }

  // ─── Regime compatibility ──────────────────────────────────────────────
  let regimePenalty = 0;
  let regimeCompat: ScoredDetection["marketRegimeCompatibility"] = "moderate";
  if (ctx.regime) {
    const trend = /Trending/.test(ctx.regime);
    const choppy = /Choppy|Sideways/.test(ctx.regime);
    const highVol = /High Volatility/.test(ctx.regime);
    if (isReversal(raw.category)) {
      if (choppy) {
        regimeCompat = "strong";
        regimePenalty = 4;
      } else if (trend) {
        regimeCompat = "weak";
        regimePenalty = -7;
      }
    } else if (raw.category === "Continuation" || raw.category === "Momentum") {
      if (trend) {
        regimeCompat = "strong";
        regimePenalty = 5;
      } else if (choppy) {
        regimeCompat = "weak";
        regimePenalty = -6;
      }
    } else if (raw.category === "Breakout Confirmation") {
      if (highVol) {
        regimeCompat = "strong";
        regimePenalty = 4;
      } else if (choppy) {
        regimeCompat = "weak";
        regimePenalty = -5;
      }
    } else if (raw.category === "Indecision") {
      // Indecision patterns are stronger in chop than in trend.
      if (choppy) regimePenalty = 2;
      else regimePenalty = -2;
    }
  }

  // ─── Volatility penalty ────────────────────────────────────────────────
  let volatilityPenalty = 0;
  if (ctx.atrPct != null) {
    if (ctx.atrPct > 4) volatilityPenalty = -5;
    else if (ctx.atrPct < 0.3) volatilityPenalty = -3;
  }

  const total = clamp(
    base +
      trendDelta +
      volumeDelta +
      rsiDelta +
      emaDelta +
      vwapDelta +
      htfDelta +
      adxBoost +
      regimePenalty +
      volatilityPenalty,
    0,
    100,
  );

  const breakdown: ConfidenceBreakdown = {
    base,
    trendAlignment: trendDelta,
    volumeConfirmation: volumeDelta,
    rsiConfirmation: rsiDelta,
    emaConfirmation: emaDelta,
    vwapConfirmation: vwapDelta,
    htfAlignment: htfDelta,
    adxBoost,
    regimePenalty,
    volatilityPenalty,
    total,
  };

  const reasoning = buildReasoning(raw, breakdown, regimeCompat, trendAlignment);
  const patternStrength = Math.round(raw.rawStrength * reliability);

  return {
    patternId: raw.patternId,
    patternName: raw.patternName,
    category: raw.category,
    direction: raw.direction,
    timeframe,
    detectionTime: raw.detectionTime,
    confidenceScore: total,
    patternStrength,
    trendAlignment,
    volumeConfirmation,
    higherTimeframeAlignment: ctx.higherTimeframeAgrees === true,
    marketRegimeCompatibility: regimeCompat,
    breakdown,
    reasoning,
  };
}

function isReversal(category: PatternCategory): boolean {
  return category === "Bullish Reversal" || category === "Bearish Reversal" || category === "Exhaustion";
}

function rollingMean<T>(arr: T[], pick: (t: T) => number): number {
  if (arr.length === 0) return 0;
  let sum = 0;
  for (const t of arr) sum += pick(t);
  return sum / arr.length;
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function buildReasoning(
  raw: RawDetection,
  breakdown: ConfidenceBreakdown,
  regimeCompat: ScoredDetection["marketRegimeCompatibility"],
  trendAlignment: ScoredDetection["trendAlignment"],
): string {
  const parts: string[] = [];
  parts.push(`${raw.patternName} (${raw.direction}) — ${raw.category}`);
  if (regimeCompat === "strong") parts.push("regime supportive");
  else if (regimeCompat === "weak") parts.push("regime headwind");
  if (trendAlignment === "with") parts.push("trend agrees");
  else if (trendAlignment === "against") parts.push("counter-trend");
  if (breakdown.volumeConfirmation >= 6) parts.push("volume spike");
  if (breakdown.htfAlignment > 0) parts.push("HTF aligned");
  if (breakdown.rsiConfirmation >= 6) parts.push("RSI confirms");
  return parts.join(" · ");
}

/**
 * Compute the confirmation context from a raw candle window. Used by the
 * client-side overlay hook (which doesn't have access to the server-side
 * `IndicatorContext`).
 */
export function buildConfirmationContext(
  candles: Candle[],
  regime?: string,
): ConfirmationContext {
  if (candles.length === 0) {
    return { candles, barIndex: -1, regime };
  }
  const closes = candles.map((c) => c.close);
  const ema50 = lastNumber(ema(closes, 50));
  const ema200 = lastNumber(ema(closes, 200));
  const rsi14 = lastNumber(rsi(closes, 14));
  const vwapVal = lastNumber(vwap(candles));
  return {
    candles,
    barIndex: candles.length - 1,
    ema50,
    ema200,
    rsi14,
    vwap: vwapVal,
    regime,
  };
}
