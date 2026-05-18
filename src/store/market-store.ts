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

interface MarketState {
  symbol: string;
  interval: Timeframe;
  status: ConnectionStatus;
  ticker: Ticker24h | null;
  tickers: Record<string, Ticker24h>;
  candles: Record<string, Candle[]>;
  lastPrice: number | null;
  /** Last live candle for the active (symbol, interval). */
  liveCandle: Candle | null;
  /** Most recent close timestamp we've published. */
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
  interval: "1m",
  status: "idle",
  ticker: null,
  tickers: {},
  candles: {},
  lastPrice: null,
  liveCandle: null,
  lastUpdate: 0,

  setSymbol: (symbol) => set({ symbol }),
  setInterval: (interval) => set({ interval }),
  setStatus: (status) => set({ status }),
  setTicker: (ticker) =>
    set((state) => ({
      ticker: ticker.symbol === state.symbol ? ticker : state.ticker,
      tickers: { ...state.tickers, [ticker.symbol]: ticker },
      lastPrice: ticker.symbol === state.symbol ? ticker.last : state.lastPrice,
      lastUpdate: Date.now(),
    })),
  setCandles: (symbol, interval, candles) =>
    set((state) => ({
      candles: {
        ...state.candles,
        [`${symbol}:${interval}`]: candles,
      },
      liveCandle:
        symbol === state.symbol && interval === state.interval
          ? candles.at(-1) ?? state.liveCandle
          : state.liveCandle,
      lastPrice:
        symbol === state.symbol && interval === state.interval
          ? candles.at(-1)?.close ?? state.lastPrice
          : state.lastPrice,
      lastUpdate: Date.now(),
    })),
  setLiveCandle: (candle) =>
    set({ liveCandle: candle, lastPrice: candle.close, lastUpdate: Date.now() }),
  setSymbolLiveCandle: (symbol, interval, candle) =>
    set((state) => {
      const key = `${symbol}:${interval}`;
      const existing = state.candles[key] ?? EMPTY_ARRAY;
      const last = existing.at(-1);
      const next =
        last && last.time === candle.time
          ? [...existing.slice(0, -1), candle]
          : [...existing.slice(-499), candle];

      return {
        candles: { ...state.candles, [key]: next },
        liveCandle:
          symbol === state.symbol && interval === state.interval
            ? candle
            : state.liveCandle,
        lastPrice:
          symbol === state.symbol && interval === state.interval
            ? candle.close
            : state.lastPrice,
        lastUpdate: Date.now(),
      };
    }),
}));
