"use client";

import { useMemo } from "react";
import { ArrowDown, ArrowUp, CircleDot, Clock4 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useMarketStore } from "@/store/market-store";
import { usePortfolioStore } from "@/store/portfolio-store";
import type { Timeframe } from "@/types/market";
import { cn, formatPct, formatPrice } from "@/lib/utils";

import { PriceChart, type ChartMarker } from "./price-chart";

import { SYMBOL_NAMES } from "@/lib/market/symbols";

const TIMEFRAMES: Timeframe[] = ["1m", "5m", "15m", "1h", "4h", "1d"];

export function ChartPanel() {
  const symbol = useMarketStore((s) => s.symbol);
  const interval = useMarketStore((s) => s.interval);
  const setInterval = useMarketStore((s) => s.setInterval);
  const tickers = useMarketStore((s) => s.tickers);
  const ticker = tickers[symbol];
  const liveCandle = useMarketStore((s) => s.liveCandle);
  const history = useMarketStore((s) => s.candles[`${symbol}:${interval}`]);
  
  const orders = usePortfolioStore((s) => s.orders);
  const positions = usePortfolioStore((s) => s.positions);

  const markers = useMemo(() => {
    const symbolOrders = orders.filter(o => o.symbol === symbol && o.status === "FILLED");
    const symbolClosed = positions.filter(p => p.symbol === symbol && p.status === "CLOSED");

    const list: ChartMarker[] = [];

    // Add entry markers
    symbolOrders.forEach(o => {
      const time = o.filledAt ? Math.floor(new Date(o.filledAt).getTime() / 1000) : 0;
      if (!time) return;

      list.push({
        time,
        position: o.side === "LONG" ? "belowBar" : "aboveBar",
        color: o.side === "LONG" ? "#00E676" : "#FF5252",
        shape: o.side === "LONG" ? "arrowUp" : "arrowDown",
        text: `${o.side} @ ${o.price}`,
      });
    });

    // Add exit markers
    symbolClosed.forEach(p => {
      const time = p.closedAt ? Math.floor(new Date(p.closedAt).getTime() / 1000) : 0;
      if (!time) return;

      const side = p.side === "LONG" ? "SELL" : "COVER";
      list.push({
        time,
        position: p.side === "LONG" ? "aboveBar" : "belowBar",
        color: "#FACC15", // Yellow for exit
        shape: p.side === "LONG" ? "arrowDown" : "arrowUp",
        text: `${side} @ ${p.exitPrice}`,
      });
    });

    return list.sort((a, b) => a.time - b.time);
  }, [orders, positions, symbol]);

  const isUp = (ticker?.changePct ?? 0) >= 0;
  const lastPrice = liveCandle?.close ?? ticker?.last ?? null;

  const headerStats = useMemo(
    () => [
      {
        label: "24h High",
        value: ticker ? formatPrice(ticker.high, ticker.high < 1 ? 4 : 2) : "—",
      },
      {
        label: "24h Low",
        value: ticker ? formatPrice(ticker.low, ticker.low < 1 ? 4 : 2) : "—",
      },
      {
        label: "24h Vol",
        value: ticker
          ? `${(ticker.quoteVolume / 1_000_000).toFixed(2)}M USDT`
          : "—",
      },
    ],
    [ticker],
  );

  return (
    <div className="panel flex flex-col h-full overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4 border-b border-[var(--color-border)]">
        <div className="flex items-center gap-5">
          <div className="flex items-center gap-2.5">
            <div className="relative">
              <CircleDot className="size-4 text-[var(--color-accent)]" />
            </div>
            <div>
              <div className="flex items-baseline gap-2">
                <span className="font-semibold tracking-tight text-[15px]">
                  {symbol.replace("USDT", "")} / USDT
                </span>
                <Badge variant="muted">Binance Spot</Badge>
              </div>
              <div className="text-[11px] text-[var(--color-fg-subtle)] mt-0.5">
                {SYMBOL_NAMES[symbol] || symbol} · USD-margined
              </div>
            </div>
          </div>

          <div className="flex flex-col">
            <div
              className={cn(
                "text-mono-tabular text-2xl leading-none font-semibold tabular-nums",
                isUp ? "text-[var(--color-bull)]" : "text-[var(--color-bear)]",
              )}
            >
              {lastPrice != null ? formatPrice(lastPrice, lastPrice < 1 ? 4 : 2) : "—"}
            </div>
            <div
              className={cn(
                "mt-1 flex items-center gap-1 text-xs text-mono-tabular",
                isUp ? "text-[var(--color-bull)]" : "text-[var(--color-bear)]",
              )}
            >
              {isUp ? (
                <ArrowUp className="size-3" />
              ) : (
                <ArrowDown className="size-3" />
              )}
              {ticker ? formatPct(ticker.changePct) : "—"}
              <span className="text-[var(--color-fg-subtle)] ml-1">24h</span>
            </div>
          </div>

          <div className="hidden md:flex items-center gap-5 pl-5 border-l border-[var(--color-border)]">
            {headerStats.map((s) => (
              <div key={s.label} className="space-y-0.5">
                <div className="text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">
                  {s.label}
                </div>
                <div className="text-mono-tabular text-xs text-[var(--color-fg)]">
                  {s.value}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Tabs
            value={interval}
            onValueChange={(v) => setInterval(v as Timeframe)}
          >
            <TabsList>
              {TIMEFRAMES.map((tf) => (
                <TabsTrigger key={tf} value={tf}>
                  {tf.toUpperCase()}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <Badge variant="muted">
            <Clock4 className="size-3" />
            UTC
          </Badge>
        </div>
      </div>

      <div className="relative flex-1 min-h-[420px]">
        {!history || history.length === 0 ? (
          <div className="absolute inset-4">
            <Skeleton className="h-full w-full" />
          </div>
        ) : (
          <PriceChart candles={history} liveCandle={liveCandle} markers={markers} />
        )}
      </div>
    </div>
  );
}
