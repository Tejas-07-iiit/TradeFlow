"use client";

import { useEffect, useRef } from "react";
import {
  CandlestickSeries,
  CrosshairMode,
  HistogramSeries,
  LineStyle,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type Time,
  type UTCTimestamp,
  type SeriesMarker,
} from "lightweight-charts";

import type { Candle } from "@/types/market";

export interface ChartMarker {
  time: number;
  position: "aboveBar" | "belowBar";
  color: string;
  shape: "arrowUp" | "arrowDown";
  text: string;
}

interface PriceChartProps {
  candles: Candle[];
  /** Newest live tick (replaces or appends the last bar). */
  liveCandle?: Candle | null;
  markers?: ChartMarker[];
}

/** Map a Candle to lightweight-charts's `Time` (UTCTimestamp in seconds). */
const toTime = (sec: number) => sec as UTCTimestamp;

export function PriceChart({ candles, liveCandle, markers }: PriceChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const lastTimeRef = useRef<number>(0);

  // Initialize once
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { color: "transparent" },
        textColor: "#8A9BB5",
        fontFamily:
          "Satoshi, IBM Plex Sans, Aptos, ui-sans-serif, system-ui, sans-serif",
        fontSize: 11,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.04)", style: LineStyle.Solid },
        horzLines: { color: "rgba(255,255,255,0.04)", style: LineStyle.Solid },
      },
      rightPriceScale: {
        borderColor: "rgba(255,255,255,0.06)",
        scaleMargins: { top: 0.08, bottom: 0.28 },
      },
      timeScale: {
        borderColor: "rgba(255,255,255,0.06)",
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 6,
        barSpacing: 8,
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: "rgba(0,212,255,0.45)",
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: "#00D4FF",
        },
        horzLine: {
          color: "rgba(0,212,255,0.45)",
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: "#00D4FF",
        },
      },
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
      autoSize: false,
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
      color: "rgba(0,212,255,0.4)",
    });

    chart.priceScale("volume").applyOptions({
      scaleMargins: { top: 0.78, bottom: 0 },
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;

    // Resize observer
    const ro = new ResizeObserver(() => {
      if (!containerRef.current || !chartRef.current) return;
      chartRef.current.applyOptions({
        width: containerRef.current.clientWidth,
        height: containerRef.current.clientHeight,
      });
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
    };
  }, []);

  // Hydrate historical data
  useEffect(() => {
    if (!candleSeriesRef.current || !volumeSeriesRef.current) return;
    if (candles.length === 0) return;

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
        color:
          c.close >= c.open
            ? "rgba(0,230,118,0.45)"
            : "rgba(255,82,82,0.45)",
      })),
    );

    lastTimeRef.current = candles[candles.length - 1]?.time ?? 0;
    chartRef.current?.timeScale().fitContent();
  }, [candles]);

  // Set Markers
  useEffect(() => {
    if (!candleSeriesRef.current || !markers) return;

    const seriesMarkers: SeriesMarker<Time>[] = markers.map((m: any) => ({
      time: toTime(m.time),
      position: m.position,
      color: m.color,
      shape: m.shape,
      text: m.text,
    }));

    (candleSeriesRef.current as any).setMarkers(seriesMarkers);
  }, [markers]);

  // Live updates
  useEffect(() => {
    if (!liveCandle) return;
    if (!candleSeriesRef.current || !volumeSeriesRef.current) return;
    // Only forward updates that aren't older than what we've already plotted.
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
      color:
        liveCandle.close >= liveCandle.open
          ? "rgba(0,230,118,0.45)"
          : "rgba(255,82,82,0.45)",
    });

    if (liveCandle.time > lastTimeRef.current) {
      lastTimeRef.current = liveCandle.time;
    }
  }, [liveCandle]);

  return <div ref={containerRef} className="absolute inset-0" />;
}

export type { Time };
