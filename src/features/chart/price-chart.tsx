"use client";

import { useEffect, useRef, useMemo } from "react";
import {
  CandlestickSeries,
  CrosshairMode,
  HistogramSeries,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type Time,
  type UTCTimestamp,
  type SeriesMarker,
} from "lightweight-charts";
import { useTheme } from "next-themes";

import { chartTickMarkFormatter, chartTimeFormatter } from "@/lib/datetime";
import type { Candle } from "@/types/market";

export interface ChartMarker {
  time: number;
  position: "aboveBar" | "belowBar";
  color: string;
  shape: "arrowUp" | "arrowDown";
  text: string;
}

export interface ChartPriceLine {
  id: string;
  price: number;
  color: string;
  lineStyle?: LineStyle;
  title: string;
}

interface PriceChartProps {
  candles: Candle[];
  liveCandle?: Candle | null;
  markers?: ChartMarker[];
  priceLines?: ChartPriceLine[];
  resetKey: string;
}

const toTime = (sec: number) => sec as UTCTimestamp;

/**
 * Professional Price Chart with high-frequency marker support and
 * robust state management.
 *
 * NOTE: This component is intended to be used with a unique `key` (e.g. symbol:interval)
 * to ensure that switching datasets results in a fresh instance, preventing
 * stale state leak.
 */
export function PriceChart({
  candles,
  liveCandle,
  markers,
  priceLines,
  resetKey,
}: PriceChartProps) {
  const { resolvedTheme } = useTheme();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const markersPluginRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const priceLinesRef = useRef<Map<string, IPriceLine>>(new Map());
  
  const lastTimeRef = useRef<number>(0);
  const dataHydratedRef = useRef<boolean>(false);

  // 1. Core Chart Initialization
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { color: "transparent" },
        textColor: "#8A9BB5",
        fontFamily: "Satoshi, sans-serif",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.02)" },
        horzLines: { color: "rgba(255,255,255,0.02)" },
      },
      rightPriceScale: {
        borderColor: "rgba(255,255,255,0.06)",
        scaleMargins: { top: 0.1, bottom: 0.15 },
        autoScale: true,
        alignLabels: true,
      },
      timeScale: {
        borderColor: "rgba(255,255,255,0.06)",
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 20,
        barSpacing: 12,
        minBarSpacing: 1,
        fixLeftEdge: true,
        tickMarkFormatter: chartTickMarkFormatter,
      },
      localization: {
        timeFormatter: chartTimeFormatter,
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: "rgba(0,212,255,0.3)",
          labelBackgroundColor: "#00D4FF",
        },
        horzLine: {
          color: "rgba(0,212,255,0.3)",
          labelBackgroundColor: "#00D4FF",
        },
      },
      autoSize: true,
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#00E676",
      downColor: "#FF5252",
      borderUpColor: "#00E676",
      borderDownColor: "#FF5252",
      wickUpColor: "#00E676",
      wickDownColor: "#FF5252",
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
    });

    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
      color: "rgba(0,212,255,0.2)",
    });

    chart.priceScale("volume").applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;
    markersPluginRef.current = createSeriesMarkers(candleSeries, []);

    return () => {
      priceLinesRef.current.clear();
      markersPluginRef.current?.detach();
      markersPluginRef.current = null;
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      dataHydratedRef.current = false;
    };
  }, []);

  // Sync theme with chart
  useEffect(() => {
    if (!chartRef.current) return;
    
    const isDark = resolvedTheme !== "light";
    
    chartRef.current.applyOptions({
      layout: {
        textColor: isDark ? "#8A9BB5" : "#64748b",
      },
      grid: {
        vertLines: { color: isDark ? "rgba(255,255,255,0.02)" : "rgba(0,0,0,0.05)" },
        horzLines: { color: isDark ? "rgba(255,255,255,0.02)" : "rgba(0,0,0,0.05)" },
      },
      rightPriceScale: {
        borderColor: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.1)",
      },
      timeScale: {
        borderColor: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.1)",
      },
    });
  }, [resolvedTheme]);

  // 2. Data Hydration
  useEffect(() => {
    if (!candleSeriesRef.current || !volumeSeriesRef.current || !chartRef.current) return;
    if (candles.length === 0) return;

    // Only set data once per instance (since we use 'key' in parent)
    if (!dataHydratedRef.current) {
      candleSeriesRef.current.setData(
        candles.map((c) => ({
          time: toTime(c.time),
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
        })),
      );
      volumeSeriesRef.current.setData(
        candles.map((c) => ({
          time: toTime(c.time),
          value: c.volume,
          color: c.close >= c.open ? "rgba(0,230,118,0.25)" : "rgba(255,82,82,0.25)",
        })),
      );
      
      dataHydratedRef.current = true;
      lastTimeRef.current = candles[candles.length - 1]?.time ?? 0;

      // Ensure the chart fits the content perfectly
      setTimeout(() => {
        chartRef.current?.timeScale().fitContent();
      }, 150);
    }
  }, [candles]);

  // 3. Markers
  const optimizedMarkers = useMemo(() => {
    if (!markers) return [];
    const sorted = [...markers].sort((a, b) => a.time - b.time);
    const recent = sorted.slice(-40);
    const aggregated = new Map<string, ChartMarker>();
    
    for (const m of recent) {
      const key = `${m.time}:${m.position}`;
      const existing = aggregated.get(key);
      if (!existing) {
        aggregated.set(key, { ...m });
      } else {
        const count = (existing.text.match(/\d+ x/) ? parseInt(existing.text) : 1) + 1;
        existing.text = `${count} x ${m.shape === "arrowUp" ? "BUY" : "SELL"}`;
      }
    }
    
    return Array.from(aggregated.values()).map((m) => ({
      time: toTime(m.time),
      position: m.position,
      color: m.color,
      shape: m.shape,
      text: m.text,
    })) as SeriesMarker<Time>[];
  }, [markers]);

  useEffect(() => {
    if (!markersPluginRef.current) return;
    markersPluginRef.current.setMarkers(optimizedMarkers);
  }, [optimizedMarkers]);

  // 4. Overlays (Price Lines)
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series) return;
    const live = priceLinesRef.current;
    const next = priceLines ?? [];
    const nextIds = new Set(next.map((l) => l.id));

    for (const [id, handle] of live) {
      if (!nextIds.has(id)) {
        series.removePriceLine(handle);
        live.delete(id);
      }
    }

    for (const line of next) {
      const opts = {
        price: line.price,
        color: line.color,
        lineStyle: line.lineStyle ?? LineStyle.Dashed,
        lineWidth: 1 as const,
        axisLabelVisible: true,
        title: line.title,
      };
      const existing = live.get(line.id);
      if (existing) {
        existing.applyOptions(opts);
      } else {
        live.set(line.id, series.createPriceLine(opts));
      }
    }
  }, [priceLines]);

  // 5. Real-time Stream Updates
  useEffect(() => {
    if (!liveCandle) return;
    if (!candleSeriesRef.current || !volumeSeriesRef.current) return;
    
    // Safety: Only update if the tick is newer than or same as our last known point
    if (liveCandle.time < lastTimeRef.current) return;

    candleSeriesRef.current.update({
      time: toTime(liveCandle.time),
      open: liveCandle.open,
      high: liveCandle.high,
      low: liveCandle.low,
      close: liveCandle.close,
    });
    
    volumeSeriesRef.current.update({
      time: toTime(liveCandle.time),
      value: liveCandle.volume,
      color: liveCandle.close >= liveCandle.open ? "rgba(0,230,118,0.25)" : "rgba(255,82,82,0.25)",
    });

    if (liveCandle.time > lastTimeRef.current) {
      lastTimeRef.current = liveCandle.time;
    }
  }, [liveCandle]);

  return <div ref={containerRef} className="absolute inset-0" />;
}
