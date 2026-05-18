"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MiniBars, StatusBadge } from "@/components/shared/page-shell";
import { SYMBOL_NAMES, WATCHLIST_SYMBOLS } from "@/lib/market/symbols";
import { cn, formatPct, formatPrice } from "@/lib/utils";
import { useMarketStore } from "@/store/market-store";
import type { Ticker24h } from "@/types/market";

export function LiveWatchlist({ compact = false }: { compact?: boolean }) {
  const tickers = useMarketStore((state) => state.tickers);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Realtime Watchlist</CardTitle>
        <StatusBadge tone="accent">Live</StatusBadge>
      </CardHeader>
      <CardContent className="space-y-2">
        {WATCHLIST_SYMBOLS.map((symbol) => (
          <WatchlistRow
            key={symbol}
            symbol={symbol}
            ticker={tickers[symbol]}
            compact={compact}
          />
        ))}
      </CardContent>
    </Card>
  );
}

function WatchlistRow({
  symbol,
  ticker,
  compact,
}: {
  symbol: string;
  ticker?: Ticker24h;
  compact: boolean;
}) {
  const up = (ticker?.changePct ?? 0) >= 0;
  const values = ticker
    ? [ticker.open, ticker.low, ticker.last, ticker.high].map((value) =>
        Math.max(1, value - ticker.low + 1),
      )
    : [2, 2, 2, 2];

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md border border-[var(--color-border)] bg-white/[0.02] px-3 py-2.5">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-[var(--color-fg)]">
            {symbol}
          </span>
          {!compact ? <Badge variant="muted">{SYMBOL_NAMES[symbol]}</Badge> : null}
        </div>
        <div className="mt-1 text-mono-tabular text-xs text-[var(--color-fg-muted)]">
          {ticker ? formatPrice(ticker.last, ticker.last < 10 ? 4 : 2) : "Connecting"}
        </div>
      </div>
      <div className="flex items-center gap-3">
        {!compact ? <MiniBars values={values} tone={up ? "bull" : "bear"} /> : null}
        <span
          className={cn(
            "text-mono-tabular text-sm",
            up ? "text-[var(--color-bull)]" : "text-[var(--color-bear)]",
          )}
        >
          {ticker ? formatPct(ticker.changePct) : "—"}
        </span>
      </div>
    </div>
  );
}
