import type { Candle, Timeframe } from "@/types/market";

import { readDetections, writeDetections } from "./cache";
import {
  buildConfirmationContext,
  scoreDetection,
  type ConfirmationContext,
} from "./confidence";
import { DETECTORS } from "./detectors";
import type {
  CandlestickIntelligence,
  PatternCategory,
  PatternDirection,
  RawDetection,
  ScoredDetection,
} from "./types";

/**
 * `runCandlestickEngine` — single source of truth for pattern intelligence.
 *
 * Contract:
 *   - Accept the FULL candle window (the engine needs history for the
 *     averaging period inside body-stats).
 *   - Evaluate every detector against the *last fully-closed bar* only —
 *     callers must trim the partial in-progress bar before calling.
 *   - Cache the resulting `ScoredDetection[]` by (symbol, timeframe, barTime)
 *     so additional ticks on the same bar return instantly.
 *
 * The engine returns the structured `CandlestickIntelligence` that
 * downstream layers (strategy fusion, LLM, chart overlay) consume.
 */
export interface EngineInput {
  symbol: string;
  timeframe: Timeframe;
  candles: Candle[];
  /** Optional pre-computed indicator context (server-side path). */
  context?: Partial<ConfirmationContext>;
  /** Set true to bypass the cache (e.g. backtesting). */
  forceFresh?: boolean;
  /** Detections must clear this confidence floor to be surfaced. */
  minConfidence?: number;
}

export function runCandlestickEngine(input: EngineInput): CandlestickIntelligence {
  const { symbol, timeframe, candles, forceFresh = false, minConfidence = 50 } = input;
  if (candles.length < 14) return emptyIntel(symbol, timeframe);

  const lastIdx = candles.length - 1;
  const barTime = candles[lastIdx].time;

  if (!forceFresh) {
    const hit = readDetections(symbol, timeframe, barTime);
    if (hit) return aggregate(symbol, timeframe, hit, minConfidence);
  }

  const ctx: ConfirmationContext = {
    ...buildConfirmationContext(candles, input.context?.regime),
    ...input.context,
  };
  ctx.candles = candles;
  ctx.barIndex = lastIdx;

  const scored: ScoredDetection[] = [];
  for (const def of DETECTORS) {
    if (lastIdx + 1 < def.lookback) continue;
    let signed = 0;
    try {
      signed = def.detect(candles, lastIdx);
    } catch (err) {
      // A detector misfire shouldn't kill the whole pipeline — log once and
      // move on so the rest of the suite still produces.
      console.error(`[candlestick] ${def.id} threw:`, err);
      continue;
    }
    if (signed === 0) continue;
    const direction: PatternDirection = signed > 0 ? "bullish" : "bearish";
    const raw: RawDetection = {
      patternId: def.id,
      patternName: def.name,
      category: def.category,
      direction,
      rawStrength: 100,
      barIndex: lastIdx,
      detectionTime: barTime,
    };
    scored.push(scoreDetection(raw, ctx, timeframe, def.reliability));
  }

  // Sort by confidence so the LLM payload + chart overlay are deterministic.
  scored.sort((a, b) => b.confidenceScore - a.confidenceScore);
  writeDetections(symbol, timeframe, barTime, scored);
  return aggregate(symbol, timeframe, scored, minConfidence);
}

function aggregate(
  symbol: string,
  timeframe: Timeframe,
  all: ScoredDetection[],
  minConfidence: number,
): CandlestickIntelligence {
  const active = all.filter((d) => d.confidenceScore >= minConfidence);
  let bullishCount = 0;
  let bearishCount = 0;
  let neutralCount = 0;
  let weightedSum = 0;
  let totalWeight = 0;
  for (const d of active) {
    if (d.direction === "bullish") bullishCount += 1;
    else if (d.direction === "bearish") bearishCount += 1;
    else neutralCount += 1;
    const sign = d.direction === "bullish" ? 1 : d.direction === "bearish" ? -1 : 0;
    weightedSum += sign * d.confidenceScore;
    totalWeight += d.confidenceScore;
  }
  const netBias =
    totalWeight === 0 ? 0 : Math.round((weightedSum / totalWeight) * 100);
  const top = active[0];
  const topConfidence = top?.confidenceScore ?? 0;
  const dominantCategory = computeDominantCategory(active);
  const narrative = buildNarrative(active, netBias, dominantCategory);

  return {
    symbol,
    primaryTimeframe: timeframe,
    detections: active,
    bullishCount,
    bearishCount,
    neutralCount,
    netBias,
    topConfidence,
    dominantCategory,
    narrative,
  };
}

function computeDominantCategory(
  active: ScoredDetection[],
): PatternCategory | null {
  if (active.length === 0) return null;
  const buckets = new Map<PatternCategory, number>();
  for (const d of active) {
    const cur = buckets.get(d.category) ?? 0;
    buckets.set(d.category, cur + d.confidenceScore);
  }
  let best: PatternCategory | null = null;
  let bestScore = -Infinity;
  for (const [cat, score] of buckets) {
    if (score > bestScore) {
      bestScore = score;
      best = cat;
    }
  }
  return best;
}

function buildNarrative(
  active: ScoredDetection[],
  netBias: number,
  dominantCategory: PatternCategory | null,
): string {
  if (active.length === 0) {
    return "No high-confidence candlestick patterns on the current bar.";
  }
  const top = active.slice(0, 3).map((d) => `${d.patternName} (${d.confidenceScore})`).join(", ");
  const lean = netBias > 15 ? "bullish lean" : netBias < -15 ? "bearish lean" : "mixed signals";
  const cat = dominantCategory ? `, dominated by ${dominantCategory}` : "";
  return `Top: ${top}. ${lean}${cat}.`;
}

function emptyIntel(symbol: string, timeframe: Timeframe): CandlestickIntelligence {
  return {
    symbol,
    primaryTimeframe: timeframe,
    detections: [],
    bullishCount: 0,
    bearishCount: 0,
    neutralCount: 0,
    netBias: 0,
    topConfidence: 0,
    dominantCategory: null,
    narrative: "Window too short for candlestick detection.",
  };
}
