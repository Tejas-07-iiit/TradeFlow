"use client";

import { useEffect } from "react";

import { WATCHLIST_SYMBOLS } from "@/lib/market/symbols";
import { fetchHistoricalCandles } from "@/services/binance";
import { BinanceMarketStream } from "@/services/binance/market-stream";
import { useMarketStore } from "@/store/market-store";
import type { Timeframe } from "@/types/market";

export function useMarketData(interval: Timeframe = "1m") {
  const symbol = useMarketStore((state) => state.symbol);
  const setStatus = useMarketStore((state) => state.setStatus);
  const setTicker = useMarketStore((state) => state.setTicker);
  const setCandles = useMarketStore((state) => state.setCandles);
  const setSymbolLiveCandle = useMarketStore(
    (state) => state.setSymbolLiveCandle,
  );

  useEffect(() => {
    let cancelled = false;

    // Fetch primary timeframe
    fetchHistoricalCandles(symbol, interval, 500)
      .then((candles) => {
        if (!cancelled) setCandles(symbol, interval, candles);
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });

    // Fetch background HTF confirmation
    const htf = interval === "1m" ? "15m" : interval === "5m" ? "1h" : null;
    if (htf) {
      fetchHistoricalCandles(symbol, htf as Timeframe, 100).then((candles) => {
        if (!cancelled) setCandles(symbol, htf as Timeframe, candles);
      });
    }

    const stream = new BinanceMarketStream(
      [...WATCHLIST_SYMBOLS],
      interval,
      symbol,
      {
        onStatus: setStatus,
        onTicker: setTicker,
        onCandle: setSymbolLiveCandle,
      },
    );
    stream.connect();

    return () => {
      cancelled = true;
      stream.disconnect();
    };
  }, [symbol, interval, setCandles, setStatus, setSymbolLiveCandle, setTicker]);
}

