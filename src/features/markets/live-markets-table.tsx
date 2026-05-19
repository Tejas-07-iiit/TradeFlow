"use client";

import { useMemo, useState } from "react";
import { ArrowDownUp, Search } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { MiniBars, StatusBadge } from "@/components/shared/page-shell";
import { SYMBOL_NAMES, WATCHLIST_SYMBOLS } from "@/lib/market/symbols";
import { calculateIndicators } from "@/lib/signals/signal-engine";
import { cn, formatPct, formatPrice } from "@/lib/utils";
import { EMPTY_ARRAY, useMarketStore } from "@/store/market-store";
import type { Ticker24h } from "@/types/market";

type SortKey = "symbol" | "last" | "changePct" | "quoteVolume";

export function LiveMarketsTable() {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("changePct");
  const tickers = useMarketStore((state) => state.tickers);
  const interval = useMarketStore((state) => state.interval);
  const candles = useMarketStore((state) => state.candles[`BTCUSDT:${interval}`] ?? EMPTY_ARRAY);
  const btcIndicators = calculateIndicators(candles);

  const rows = useMemo(() => {
    return WATCHLIST_SYMBOLS.map((symbol) => tickers[symbol])
      .filter(Boolean)
      .filter((ticker) => {
        const q = query.toLowerCase();
        return (
          ticker.symbol.toLowerCase().includes(q) ||
          SYMBOL_NAMES[ticker.symbol]?.toLowerCase().includes(q)
        );
      })
      .sort((a, b) => {
        if (sort === "symbol") return a.symbol.localeCompare(b.symbol);
        return Number(b[sort]) - Number(a[sort]);
      });
  }, [query, sort, tickers]);

  return (
    <div className="panel overflow-hidden">
      <div className="flex flex-col gap-3 border-b border-[var(--color-border)] p-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-sm font-semibold text-[var(--color-fg)]">
            Live Market Overview
          </h2>
          <p className="mt-1 text-xs text-[var(--color-fg-muted)]">
            Binance 24h ticker stream with realtime price, volume, volatility, and regime context.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-[var(--color-fg-subtle)]" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search markets"
              className="h-9 min-w-[220px] pl-9"
            />
          </div>
          <select
            value={sort}
            onChange={(event) => setSort(event.target.value as SortKey)}
            className="h-9 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 text-xs text-[var(--color-fg)] outline-none"
          >
            <option value="changePct">Sort: 24h Change</option>
            <option value="last">Sort: Price</option>
            <option value="symbol">Sort: Symbol</option>
            <option value="quoteVolume">Sort: Volume</option>
          </select>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[780px] text-left text-sm">
          <thead className="border-b border-[var(--color-border)] text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">
            <tr>
              {["Asset", "Price", "24h", "Volume", "Volatility", "Regime", "Micro Trend"].map((heading) => (
                <th key={heading} className="px-4 py-3 font-medium">
                  <span className="inline-flex items-center gap-1">
                    {heading}
                    {["Asset", "Price", "24h", "Volume"].includes(heading) ? <ArrowDownUp className="size-3" /> : null}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border)]">
            {rows.map((ticker) => (
              <MarketRow
                key={ticker.symbol}
                ticker={ticker}
                regime={ticker.symbol === "BTCUSDT" ? btcIndicators.regime : deriveTickerRegime(ticker)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MarketRow({ ticker, regime }: { ticker: Ticker24h; regime: string }) {
  const up = ticker.changePct >= 0;
  const volatilityPct = ((ticker.high - ticker.low) / ticker.last) * 100;
  const spark = [ticker.open, ticker.low, ticker.last, ticker.high].map((value) =>
    Math.max(1, value - ticker.low + 1),
  );

  return (
    <tr className="hover:bg-white/[0.025]">
      <td className="px-4 py-3">
        <div className="font-medium text-[var(--color-fg)]">{ticker.symbol}</div>
        <div className="text-xs text-[var(--color-fg-subtle)]">{SYMBOL_NAMES[ticker.symbol]}</div>
      </td>
      <td className="px-4 py-3 text-mono-tabular text-[var(--color-fg)]">
        {formatPrice(ticker.last, ticker.last < 10 ? 4 : 2)}
      </td>
      <td className={cn("px-4 py-3 text-mono-tabular", up ? "text-[var(--color-bull)]" : "text-[var(--color-bear)]")}>
        {formatPct(ticker.changePct)}
      </td>
      <td className="px-4 py-3 text-mono-tabular text-[var(--color-fg-muted)]">
        {(ticker.quoteVolume / 1_000_000_000).toFixed(2)}B
      </td>
      <td className="px-4 py-3">
        <Badge variant={volatilityPct > 5 ? "warn" : "muted"}>{volatilityPct.toFixed(2)}%</Badge>
      </td>
      <td className="px-4 py-3">
        <StatusBadge tone={regime.includes("Up") ? "bull" : regime.includes("Down") ? "bear" : regime.includes("Vol") ? "warn" : "muted"}>{regime}</StatusBadge>
      </td>
      <td className="px-4 py-3">
        <MiniBars values={spark} tone={up ? "bull" : "bear"} />
      </td>
    </tr>
  );
}

function deriveTickerRegime(ticker: Ticker24h) {
  const rangePct = ((ticker.high - ticker.low) / ticker.last) * 100;
  if (rangePct > 5) return "High Volatility";
  if (ticker.changePct > 1) return "Trending Up";
  if (ticker.changePct < -1) return "Trending Down";
  return "Sideways";
}
