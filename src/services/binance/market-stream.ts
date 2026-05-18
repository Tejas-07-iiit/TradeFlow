import type {
  BinanceCombinedMessage,
  BinanceKlineStreamPayload,
  BinanceTickerStreamPayload,
  Candle,
  ConnectionStatus,
  Ticker24h,
  Timeframe,
} from "@/types/market";

import {
  buildCombinedStreamUrl,
  klineStream,
  ticker24hStream,
} from "@/services/binance";

type Handlers = {
  onStatus: (status: ConnectionStatus) => void;
  onTicker: (ticker: Ticker24h) => void;
  onCandle: (symbol: string, interval: Timeframe, candle: Candle) => void;
};

export class BinanceMarketStream {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private staleTimer: ReturnType<typeof setInterval> | null = null;
  private explicitClose = false;
  private retries = 0;
  private lastMessageAt = 0;

  constructor(
    private readonly symbols: string[],
    private readonly interval: Timeframe,
    private readonly klineSymbol: string,
    private readonly handlers: Handlers,
  ) {}

  connect() {
    this.disconnect(false);
    this.explicitClose = false;
    this.open();
  }

  disconnect(markExplicit = true) {
    this.explicitClose = markExplicit;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.staleTimer) clearInterval(this.staleTimer);
    this.reconnectTimer = null;
    this.staleTimer = null;
    this.ws?.close();
    this.ws = null;
    if (markExplicit) this.handlers.onStatus("closed");
  }

  private open() {
    const streams = [
      ...this.symbols.map((symbol) => ticker24hStream(symbol)),
      klineStream(this.klineSymbol, this.interval),
    ];

    this.handlers.onStatus(this.retries === 0 ? "connecting" : "reconnecting");
    this.lastMessageAt = Date.now();

    try {
      this.ws = new WebSocket(buildCombinedStreamUrl(streams));
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.retries = 0;
      this.handlers.onStatus("open");
      this.monitorStaleness();
    };

    this.ws.onmessage = (event) => {
      this.lastMessageAt = Date.now();
      try {
        this.dispatch(JSON.parse(event.data as string) as BinanceCombinedMessage);
      } catch {
        // Ignore malformed exchange payloads.
      }
    };

    this.ws.onerror = () => this.handlers.onStatus("error");
    this.ws.onclose = () => {
      if (this.staleTimer) clearInterval(this.staleTimer);
      if (!this.explicitClose) this.scheduleReconnect();
    };
  }

  private dispatch(message: BinanceCombinedMessage) {
    const data = message.data;
    if ("k" in data && data.e === "kline") {
      this.handlers.onCandle(data.s, data.k.i as Timeframe, klineToCandle(data));
      return;
    }
    if (data.e === "24hrTicker") {
      this.handlers.onTicker(parseTicker(data));
    }
  }

  private monitorStaleness() {
    if (this.staleTimer) clearInterval(this.staleTimer);
    this.staleTimer = setInterval(() => {
      if (Date.now() - this.lastMessageAt > 45_000) {
        this.ws?.close();
      }
    }, 15_000);
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.retries += 1;
    this.handlers.onStatus("reconnecting");
    const backoff = Math.min(30_000, Math.round(900 * 1.7 ** this.retries));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, backoff);
  }
}

function klineToCandle(payload: BinanceKlineStreamPayload): Candle {
  return {
    time: Math.floor(payload.k.t / 1000),
    open: Number(payload.k.o),
    high: Number(payload.k.h),
    low: Number(payload.k.l),
    close: Number(payload.k.c),
    volume: Number(payload.k.v),
  };
}

function parseTicker(payload: BinanceTickerStreamPayload): Ticker24h {
  return {
    symbol: payload.s,
    last: Number(payload.c),
    open: Number(payload.o),
    high: Number(payload.h),
    low: Number(payload.l),
    changePct: Number(payload.P),
    quoteVolume: Number(payload.q),
    baseVolume: Number(payload.v),
    bestBid: payload.b ? Number(payload.b) : undefined,
    bestAsk: payload.a ? Number(payload.a) : undefined,
  };
}
