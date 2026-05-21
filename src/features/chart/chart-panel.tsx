"use client";

import { useMemo } from "react";
import { ArrowDown, ArrowUp, CircleDot, Clock4, Sparkles } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAiDecisionStore } from "@/store/ai-decision-store";
import { useMarketStore } from "@/store/market-store";
import { usePortfolioStore } from "@/store/portfolio-store";
import { decisionSide } from "@/services/ai/schemas";
import {
  useCandlestickChartMarkers,
  useCandlestickPatterns,
} from "@/hooks/use-candlestick-patterns";
import type { Timeframe } from "@/types/market";
import { cn, formatPct, formatPrice } from "@/lib/utils";

import { PriceChart, type ChartMarker, type ChartPriceLine } from "./price-chart";

import { SYMBOL_NAMES } from "@/lib/market/symbols";

const SOURCE_PREFIX: Record<string, string> = {
  LLM: "AI",
  RULE: "RULE",
  MANUAL: "MAN",
};

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
  const llmDecision = useAiDecisionStore((s) => s.bySymbol[symbol]);

  // 61-pattern TA-Lib candlestick intelligence — live, throttled per bar.
  const candlestickIntel = useCandlestickPatterns(symbol, interval, history);
  const candlestickMarkers = useCandlestickChartMarkers(candlestickIntel);

  const priceLines = useMemo<ChartPriceLine[]>(() => {
    const lines: ChartPriceLine[] = [];
    for (const p of positions) {
      if (p.symbol !== symbol) continue;
      if (p.status !== "OPEN" && p.status !== "PARTIALLY_CLOSED") continue;
      const sideTag = p.side === "LONG" ? "L" : "S";
      const prefix = p.decisionSource === "LLM" ? "AI " : "";
      lines.push({
        id: `${p.id}:entry`,
        price: p.entryPrice,
        color: p.side === "LONG" ? "#00E676" : "#FF5252",
        title: `${prefix}${sideTag} ENTRY ${p.quantity}`,
      });
      if (p.takeProfit != null) {
        lines.push({
          id: `${p.id}:tp`,
          price: p.takeProfit,
          color: "#00E676",
          title: `${prefix}TP`,
        });
      }
      if (p.stopLoss != null) {
        lines.push({
          id: `${p.id}:sl`,
          price: p.stopLoss,
          color: "#FF5252",
          title: `${prefix}SL`,
        });
      }
    }

    // LLM-projected trade — render when the active decision is executable
    // AND we don't already hold an LLM position for this symbol (otherwise
    // we'd be double-drawing the same levels). Distinct colors + an "AI
    // PROJ" prefix so it's clearly an intention, not a live order.
    if (llmDecision?.decision) {
      const d = llmDecision.decision;
      const side = decisionSide(d.decision);
      const hasOpenLlmPos = positions.some(
        (p) =>
          p.symbol === symbol &&
          p.decisionSource === "LLM" &&
          (p.status === "OPEN" || p.status === "PARTIALLY_CLOSED"),
      );
      if (d.executeTrade && side && !hasOpenLlmPos) {
        lines.push({
          id: `llm:entry:${symbol}`,
          price: d.entryPrice,
          color: "#00D4FF",
          title: `AI PROJ ${side} ${d.setupQuality}`,
        });
        lines.push({
          id: `llm:tp:${symbol}`,
          price: d.takeProfit,
          color: "#80E1FF",
          title: `AI PROJ TP`,
        });
        lines.push({
          id: `llm:sl:${symbol}`,
          price: d.stopLoss,
          color: "#FF8080",
          title: `AI PROJ SL`,
        });
      }
    }

    return lines;
  }, [positions, symbol, llmDecision]);

  const tradeHistory = usePortfolioStore((s) => s.tradeHistory);

  const markers = useMemo(() => {
    // 1. Filter and limit raw inputs to prevent performance degradation
    const symbolOrders = orders
      .filter((o) => o.symbol === symbol && o.status === "FILLED")
      .slice(-50);
    const symbolHistory = tradeHistory
      .filter((t) => t.symbol === symbol)
      .slice(-50);

    const list: ChartMarker[] = [];

    // 2. Process fills (Entry/Add markers)
    symbolOrders.forEach((o) => {
      const rawTime = o.filledAt ? new Date(o.filledAt).getTime() : 0;
      const time = Math.floor(rawTime / 1000);
      if (time <= 0) return;

      const fillPrice = o.filledPrice ?? o.price ?? 0;
      const sourcePrefix = SOURCE_PREFIX[o.decisionSource] ?? "";
      list.push({
        time,
        position: o.side === "LONG" ? "belowBar" : "aboveBar",
        color: o.side === "LONG" ? "#00E676" : "#FF5252",
        shape: o.side === "LONG" ? "arrowUp" : "arrowDown",
        text: `${o.side} @ ${fillPrice}`,
      });
    });

    // 3. Process history (Exit/Close markers)
    symbolHistory.forEach((t) => {
      const rawTime = t.closedAt ? new Date(t.closedAt).getTime() : 0;
      const time = Math.floor(rawTime / 1000);
      if (time <= 0) return;

      const side = t.side === "LONG" ? "SELL" : "COVER";
      const sourcePrefix = SOURCE_PREFIX[t.decisionSource] ?? "";
      list.push({
        time,
        position: t.side === "LONG" ? "aboveBar" : "belowBar",
        color:
          t.closeReason === "TAKE_PROFIT"
            ? "#00E676"
            : t.closeReason === "STOP_LOSS"
              ? "#FF5252"
              : t.closeReason === "AI_EXIT"
                ? "#00D4FF"
                : "#FACC15",
        shape: t.side === "LONG" ? "arrowDown" : "arrowUp",
        text: `${side} @ ${t.exitPrice}`,
      });
    });

    // Append candlestick pattern markers — these come from the local TA-Lib
    // engine and are independent of order/trade markers. Cap is enforced by
    // the hook (top 6 by confidence).
    for (const m of candlestickMarkers) list.push(m);

    return list.sort((a, b) => a.time - b.time);
  }, [orders, tradeHistory, symbol, candlestickMarkers]);

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

  // Professional History Check: Don't mount chart until we have enough baseline candles.
  // This prevents the "single candle" visual jump and broken scaling.
  const hasEnoughHistory = history && history.length > 20;

  return (
    <div className="panel flex flex-col h-full overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4 border-b border-[var(--border)]">
        <div className="flex items-center gap-5">
          <div className="flex items-center gap-2.5">
            <div className="relative">
              <CircleDot className="size-4 text-[var(--accent)]" />
            </div>
            <div>
              <div className="flex items-baseline gap-2">
                <span className="font-semibold tracking-tight text-[15px]">
                  {symbol.replace("USDT", "")} / USDT
                </span>
                <Badge variant="muted">Binance Spot</Badge>
              </div>
              <div className="text-[11px] text-[var(--fg-subtle)] mt-0.5">
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
              <span className="text-[var(--fg-subtle)] ml-1">24h</span>
            </div>
          </div>

          <div className="hidden md:flex items-center gap-5 pl-5 border-l border-[var(--border)]">
            {headerStats.map((s) => (
              <div key={s.label} className="space-y-0.5">
                <div className="text-[10px] uppercase tracking-wider text-[var(--fg-subtle)]">
                  {s.label}
                </div>
                <div className="text-mono-tabular text-xs text-[var(--fg)]">
                  {s.value}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-3">
          {candlestickIntel && candlestickIntel.detections.length > 0 && (
            <Badge
              variant={
                candlestickIntel.netBias > 15
                  ? "bull"
                  : candlestickIntel.netBias < -15
                    ? "bear"
                    : "muted"
              }
              className="text-[10px] gap-1"
              title={candlestickIntel.narrative}
            >
              <Sparkles className="size-3" />
              {candlestickIntel.detections.length} patterns ·{" "}
              {candlestickIntel.netBias > 0 ? "+" : ""}
              {candlestickIntel.netBias}
            </Badge>
          )}
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
        {!hasEnoughHistory ? (
          <div className="absolute inset-4">
            <Skeleton className="h-full w-full" />
          </div>
        ) : (
          <PriceChart
            key={`${symbol}:${interval}`}
            candles={history}
            liveCandle={liveCandle}
            markers={markers}
            priceLines={priceLines}
            resetKey={`${symbol}:${interval}`}
          />
        )}
      </div>
    </div>
  );
}
