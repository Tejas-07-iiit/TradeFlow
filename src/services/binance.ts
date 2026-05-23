import type { Candle, Timeframe } from "@/types/market";

/**
 * REST helpers for bootstrapping historical data.
 * Binance public endpoints — no API key required.
 */

const REST = "https://api.binance.com";

export async function fetchHistoricalCandles(
  symbol: string,
  interval: Timeframe,
  limit = 500,
  range: { startTime?: number; endTime?: number } = {},
): Promise<Candle[]> {
  const params = new URLSearchParams({
    symbol: symbol.toUpperCase(),
    interval,
    limit: String(Math.min(Math.max(limit, 1), 1000)),
  });
  if (range.startTime != null) params.set("startTime", String(Math.floor(range.startTime)));
  if (range.endTime != null) params.set("endTime", String(Math.floor(range.endTime)));
  const url = `${REST}/api/v3/klines?${params.toString()}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Binance REST error ${res.status}`);
  }
  const rows = (await res.json()) as Array<
    [number, string, string, string, string, string, number, string, number, string, string, string]
  >;
  return rows.map((row) => ({
    time: Math.floor(row[0] / 1000),
    open: parseFloat(row[1]),
    high: parseFloat(row[2]),
    low: parseFloat(row[3]),
    close: parseFloat(row[4]),
    volume: parseFloat(row[5]),
  }));
}

export async function fetchTicker24h(symbol: string) {
  const url = `${REST}/api/v3/ticker/24hr?symbol=${symbol.toUpperCase()}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Binance REST error ${res.status}`);
  }
  return (await res.json()) as {
    symbol: string;
    lastPrice: string;
    openPrice: string;
    highPrice: string;
    lowPrice: string;
    priceChangePercent: string;
    volume: string;
    quoteVolume: string;
    bidPrice?: string;
    askPrice?: string;
  };
}

export function buildCombinedStreamUrl(streams: string[]) {
  const joined = streams.join("/");
  return `wss://stream.binance.com:9443/stream?streams=${joined}`;
}

export function klineStream(symbol: string, interval: Timeframe) {
  return `${symbol.toLowerCase()}@kline_${interval}`;
}

export function ticker24hStream(symbol: string) {
  return `${symbol.toLowerCase()}@ticker`;
}
