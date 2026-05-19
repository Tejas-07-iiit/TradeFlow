"use client";

import { create } from "zustand";

import type {
  Candle,
  ConnectionStatus,
  Ticker24h,
  Timeframe,
} from "@/types/market";

export const EMPTY_ARRAY: any[] = [];
export const EMPTY_TICKERS: Record<string, Ticker24h> = {};
export const EMPTY_CANDLES: Record<string, Candle[]> = {};

/**
 * Validates and sorts a candle array to ensure professional rendering.
 */
function normalizeCandles(candles: Candle[]): Candle[] {
  if (candles.length === 0) return [];
  const sorted = [...candles].sort((a, b) => a.time - b.time);
  const deduped: Candle[] = [];
  for (const c of sorted) {
    if (deduped.length === 0) {
      deduped.push(c);
      continue;
    }
    const last = deduped[deduped.length - 1];
    if (last.time === c.time) {
      deduped[deduped.length - 1] = c;
    } else if (c.time > last.time) {
      deduped.push(c);
    }
  }
  return deduped;
}

interface MarketState {
  symbol: string;
  interval: Timeframe;
  status: ConnectionStatus;
  ticker: Ticker24h | null;
  tickers: Record<string, Ticker24h>;
  candles: Record<string, Candle[]>;
  lastPrice: number | null;
  liveCandle: Candle | null;
  lastUpdate: number;

  setSymbol: (symbol: string) => void;
  setInterval: (interval: Timeframe) => void;
  setStatus: (status: ConnectionStatus) => void;
  setTicker: (ticker: Ticker24h) => void;
  setCandles: (symbol: string, interval: Timeframe, candles: Candle[]) => void;
  setLiveCandle: (candle: Candle) => void;
  setSymbolLiveCandle: (
    symbol: string,
    interval: Timeframe,
    candle: Candle,
  ) => void;
}

export const useMarketStore = create<MarketState>((set) => ({
  symbol: "BTCUSDT",
  interval: "5m",
  status: "idle",
  ticker: null,
  tickers: {},
  candles: {},
  lastPrice: null,
  liveCandle: null,
  lastUpdate: 0,

  setSymbol: (symbol) => set((state) => ({ 
    symbol, 
    liveCandle: null,
    ticker: null,
    lastPrice: null,
    // Clear cache immediately to force Skeleton and prevent stale mounting
    candles: { ...state.candles, [`${symbol}:${state.interval}`]: [] }
  })),

  setInterval: (interval) => set((state) => ({ 
    interval, 
    liveCandle: null,
    candles: { ...state.candles, [`${state.symbol}:${interval}`]: [] }
  })),

  setStatus: (status) => set({ status }),
  
  setTicker: (ticker) =>
    set((state) => ({
      ticker: ticker.symbol === state.symbol ? ticker : state.ticker,
      tickers: { ...state.tickers, [ticker.symbol]: ticker },
      lastPrice: ticker.symbol === state.symbol ? ticker.last : state.lastPrice,
      lastUpdate: Date.now(),
    })),

  setCandles: (symbol, interval, candles) =>
    set((state) => {
      const normalized = normalizeCandles(candles);
      const isActive = symbol === state.symbol && interval === state.interval;

      return {
        candles: {
          ...state.candles,
          [`${symbol}:${interval}`]: normalized,
        },
        liveCandle: isActive ? normalized.at(-1) ?? null : state.liveCandle,
        lastPrice: isActive ? normalized.at(-1)?.close ?? state.lastPrice : state.lastPrice,
        lastUpdate: Date.now(),
      };
    }),

  setLiveCandle: (candle) =>
    set({ liveCandle: candle, lastPrice: candle.close, lastUpdate: Date.now() }),

  setSymbolLiveCandle: (symbol, interval, candle) =>
    set((state) => {
      const key = `${symbol}:${interval}`;
      const existing = state.candles[key] || [];

      if (!candle.time || isNaN(candle.time)) return state;

      const isActive = symbol === state.symbol && interval === state.interval;

      // STRICT GUARD: Never accumulate live ticks into an empty array.
      // This is the primary protection against the "single candle" bug.
      // We wait for the REST baseline to arrive.
      if (existing.length === 0) {
        return {
          liveCandle: isActive ? candle : state.liveCandle,
          lastPrice: isActive ? candle.close : state.lastPrice,
          lastUpdate: Date.now(),
        };
      }

      const last = existing[existing.length - 1];
      let next: Candle[];

      if (candle.time === last.time) {
        next = [...existing.slice(0, -1), candle];
      } else if (candle.time > last.time) {
        next = [...existing, candle].slice(-1000);
      } else {
        return state;
      }

      return {
        candles: { ...state.candles, [key]: next },
        liveCandle: isActive ? candle : state.liveCandle,
        lastPrice: isActive ? candle.close : state.lastPrice,
        lastUpdate: Date.now(),
      };
    }),
}));
