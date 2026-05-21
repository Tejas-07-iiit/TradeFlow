"use client";

import { Activity, Zap } from "lucide-react";
import { formatDistanceToNowStrict } from "date-fns";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useSignalStore } from "@/store/signal-store";
import { usePortfolioStore } from "@/store/portfolio-store";

export function LiveAutoExecFeed() {
  const history = useSignalStore((s) => s.autoExecHistory);
  const positions = usePortfolioStore((s) => s.positions);

  // Only show auto-executed trades that have a corresponding OPEN position.
  // This avoids confusion by only displaying what is currently "live" in the market.
  const liveTrades = history.filter((event) => {
    const side = event.signal === "BUY" ? "LONG" : "SHORT";
    return positions.some((p) => p.symbol === event.symbol && p.side === side && p.status === "OPEN");
  });

  return (
    <Card className="flex-1 min-h-0 flex flex-col">
      <CardHeader className="shrink-0">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Zap className="size-4 text-[var(--accent)]" />
            AI Active Trades
          </CardTitle>
          <div className="flex items-center gap-1.5 text-[10px] text-[var(--fg-subtle)] uppercase tracking-wider">
            <Activity className="size-3 text-[var(--color-bull)]" />
            Live
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex-1 overflow-y-auto min-h-0 pt-0">
        {liveTrades.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <div className="size-10 rounded-full bg-[var(--surface-elevated)] border border-[var(--border)] grid place-items-center mb-3">
              <Zap className="size-5 text-[var(--fg-muted)]" />
            </div>
            <p className="text-xs text-[var(--fg-subtle)]">
              No active AI trades.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {liveTrades.map((event, i) => (
              <div
                key={`${event.symbol}:${event.executedAt}:${i}`}
                className="flex items-center justify-between gap-3 p-2.5 rounded-md border border-[var(--border)] bg-[var(--surface-elevated)]"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className={cn(
                      "text-[10px] font-bold px-1.5 py-0.5 rounded uppercase",
                      event.signal === "BUY" 
                        ? "bg-[var(--color-bull-soft)] text-[var(--color-bull)]" 
                        : "bg-[var(--color-bear-soft)] text-[var(--color-bear)]"
                    )}>
                      {event.signal}
                    </span>
                    <span className="text-xs font-semibold text-[var(--fg)]">
                      {event.symbol.replace("USDT", "")}
                    </span>
                  </div>
                  <div className="text-[10px] text-[var(--fg-subtle)] truncate">
                    {event.type}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-[10px] text-[var(--fg-muted)]">
                    {formatDistanceToNowStrict(event.executedAt, { addSuffix: true })}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
