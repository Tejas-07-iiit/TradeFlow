"use client";

import { Activity, BarChart3, Clock4, ShieldCheck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { calculateIndicators } from "@/lib/signals/signal-engine";
import { formatPct } from "@/lib/utils";
import { EMPTY_ARRAY, useMarketStore } from "@/store/market-store";

export function LiveMarketMetrics() {
  const symbol = useMarketStore((state) => state.symbol);
  const interval = useMarketStore((state) => state.interval);
  const candles = useMarketStore((state) => state.candles[`${symbol}:${interval}`] ?? EMPTY_ARRAY);
  const ticker = useMarketStore((state) => state.tickers[symbol]);
  const indicators = calculateIndicators(candles);
  const metrics = [
    { label: "Market Regime", value: indicators.regime, icon: Activity },
    {
      label: "24h Change",
      value: ticker ? formatPct(ticker.changePct) : "Connecting",
      icon: BarChart3,
    },
    {
      label: "24h Volume",
      value: ticker ? `${(ticker.quoteVolume / 1_000_000).toFixed(2)}M` : "Connecting",
      icon: ShieldCheck,
    },
    {
      label: "ATR / ADX",
      value:
        indicators.atrPct && indicators.adx14
          ? `${indicators.atrPct.toFixed(2)}% / ${indicators.adx14.toFixed(1)}`
          : "Calculating",
      icon: Clock4,
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Market Metrics</CardTitle>
        <Badge variant="accent">{symbol.replace("USDT", "")} Live</Badge>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-2">
        {metrics.map((metric) => {
          const Icon = metric.icon;
          return (
            <div
              key={metric.label}
              className="rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] p-3"
            >
              <Icon className="mb-2 size-4 text-[var(--accent)]" />
              <div className="text-[10px] uppercase tracking-wider text-[var(--fg-subtle)]">
                {metric.label}
              </div>
              <div className="mt-1 text-sm font-medium text-[var(--fg)]">
                {metric.value}
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
