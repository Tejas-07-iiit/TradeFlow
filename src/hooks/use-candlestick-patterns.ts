"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import {
  runCandlestickEngine,
  type CandlestickIntelligence,
} from "@/lib/candlestick";
import type { Candle, Timeframe } from "@/types/market";

/**
 * Throttled client-side candlestick detection.
 *
 * The store fires a `liveCandle` update on every Binance tick (potentially
 * many times per second). Re-running all 61 detectors on every tick would
 * be wasteful — detections only change when a bar *closes*. We watch the
 * latest closed bar's timestamp and only invoke the engine when that
 * timestamp advances. The engine itself caches by (symbol, tf, barTime) so
 * even if we over-trigger, the second call is O(1).
 *
 * The hook returns the full `CandlestickIntelligence` snapshot — the chart
 * overlay reads `detections` for markers, the dashboard reads `narrative`,
 * `netBias`, etc.
 */
export function useCandlestickPatterns(
  symbol: string,
  timeframe: Timeframe,
  candles: Candle[] | undefined,
): CandlestickIntelligence | null {
  const [intel, setIntel] = useState<CandlestickIntelligence | null>(null);
  const lastBarTimeRef = useRef<number>(0);
  const lastSymbolKeyRef = useRef<string>("");

  useEffect(() => {
    if (!candles || candles.length < 14) {
      setIntel(null);
      lastBarTimeRef.current = 0;
      return;
    }
    const lastBar = candles[candles.length - 1];
    const symbolKey = `${symbol}:${timeframe}`;

    // Re-run when symbol/timeframe switches OR a new bar closes.
    if (
      lastSymbolKeyRef.current === symbolKey &&
      lastBar.time === lastBarTimeRef.current
    ) {
      return;
    }
    lastBarTimeRef.current = lastBar.time;
    lastSymbolKeyRef.current = symbolKey;

    try {
      const next = runCandlestickEngine({
        symbol,
        timeframe,
        candles,
      });
      setIntel(next);
    } catch (err) {
      console.error("[use-candlestick-patterns] engine threw:", err);
    }
  }, [symbol, timeframe, candles]);

  return intel;
}

/**
 * Convenience hook that derives chart markers from the intelligence.
 *
 * Markers limited to the strongest 6 active detections to avoid clutter
 * when several patterns fire on the same bar (common around indecision /
 * doji clusters).
 */
export function useCandlestickChartMarkers(
  intel: CandlestickIntelligence | null,
): { time: number; position: "aboveBar" | "belowBar"; color: string; shape: "arrowUp" | "arrowDown"; text: string }[] {
  return useMemo(() => {
    if (!intel) return [];
    return intel.detections.slice(0, 6).map((d) => ({
      time: d.detectionTime,
      position: d.direction === "bullish" ? "belowBar" : "aboveBar",
      color: colorForDetection(d.direction, d.category, d.confidenceScore),
      shape: d.direction === "bullish" ? "arrowUp" : "arrowDown",
      text: `${d.patternName} ${d.confidenceScore}`,
    }));
  }, [intel]);
}

function colorForDetection(
  direction: "bullish" | "bearish" | "neutral",
  category: string,
  confidence: number,
): string {
  if (direction === "bullish") {
    if (category === "Indecision") return "#00D4FF";
    return confidence >= 70 ? "#00E676" : "#7FE6A8";
  }
  if (direction === "bearish") {
    if (category === "Indecision") return "#00D4FF";
    return confidence >= 70 ? "#FF5252" : "#FFA89B";
  }
  return "#FACC15";
}
