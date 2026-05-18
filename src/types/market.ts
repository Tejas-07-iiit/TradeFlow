export type Timeframe = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

export interface Candle {
  /** Unix seconds (lightweight-charts native unit). */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Ticker24h {
  symbol: string;
  last: number;
  open: number;
  high: number;
  low: number;
  changePct: number;
  quoteVolume: number;
  baseVolume: number;
  bestBid?: number;
  bestAsk?: number;
}

export type ConnectionStatus =
  | "idle"
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed"
  | "error";

export interface BinanceKlineStreamPayload {
  e: "kline";
  E: number;
  s: string;
  k: {
    t: number; // open time ms
    T: number; // close time ms
    s: string;
    i: string;
    o: string;
    c: string;
    h: string;
    l: string;
    v: string;
    x: boolean; // is closed
  };
}

export interface BinanceTickerStreamPayload {
  e: "24hrTicker";
  E: number;
  s: string;
  c: string; // last
  o: string;
  h: string;
  l: string;
  v: string;
  q: string;
  P: string;
  b?: string;
  a?: string;
}

export type BinanceCombinedMessage =
  | { stream: string; data: BinanceKlineStreamPayload }
  | { stream: string; data: BinanceTickerStreamPayload };
