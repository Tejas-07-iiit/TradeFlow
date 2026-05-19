"use client";

import { Activity, BarChart3, Gauge, Radio, Search } from "lucide-react";

import { MetricCard, PageShell } from "@/components/shared/page-shell";
import { Badge } from "@/components/ui/badge";
import { LiveMarketsTable } from "@/features/markets/live-markets-table";
import { LiveWatchlist } from "@/features/markets/live-watchlist";
import { calculateIndicators } from "@/lib/signals/signal-engine";
import { formatPct, formatPrice } from "@/lib/utils";
import { EMPTY_ARRAY, useMarketStore } from "@/store/market-store";

export function LiveMarketsPage() {
  const tickers = useMarketStore((state) => state.tickers);
  const interval = useMarketStore((state) => state.interval);
  const candles = useMarketStore((state) => state.candles[`BTCUSDT:${interval}`] ?? EMPTY_ARRAY);
  const btc = tickers.BTCUSDT;
  const eth = tickers.ETHUSDT;
  const sol = tickers.SOLUSDT;
  const indicators = calculateIndicators(candles);

  return (
    <PageShell
      eyebrow="Markets"
      title="Crypto Market Overview"
      description="Institutional market monitor for live BTC context, watchlists, movers, volatility, and regime classification."
      action={<Badge variant="accent"><Radio className="size-3" /> Binance realtime</Badge>}
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        <MetricCard label="BTC Realtime" value={btc ? formatPrice(btc.last) : "Connecting"} detail={btc ? formatPct(btc.changePct) : "Ticker stream"} icon={Activity} tone={btc && btc.changePct < 0 ? "bear" : "bull"} />
        <MetricCard label="ETH Realtime" value={eth ? formatPrice(eth.last) : "Connecting"} detail={eth ? formatPct(eth.changePct) : "Ticker stream"} icon={BarChart3} tone={eth && eth.changePct < 0 ? "bear" : "accent"} />
        <MetricCard label="SOL Realtime" value={sol ? formatPrice(sol.last) : "Connecting"} detail={sol ? formatPct(sol.changePct) : "Ticker stream"} icon={Gauge} tone={sol && sol.changePct < 0 ? "bear" : "warn"} />
        <MetricCard label="BTC Regime" value={indicators.regime} detail={indicators.adx14 ? `ADX ${indicators.adx14.toFixed(1)}` : "Calculating"} icon={Search} tone={indicators.regime.includes("Up") ? "bull" : indicators.regime.includes("Down") ? "bear" : "warn"} />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <LiveMarketsTable />
        <LiveWatchlist />
      </div>
    </PageShell>
  );
}
