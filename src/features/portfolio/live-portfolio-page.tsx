"use client";

import { BarChart3, PieChart, ShieldCheck, Target, TrendingUp } from "lucide-react";

import { MetricCard, MiniBars, PageShell, StatusBadge } from "@/components/shared/page-shell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";
import { useMarketStore } from "@/store/market-store";
import type { PaperPositionView } from "@/types/portfolio";

export function LivePortfolioPage({
  balance,
  positions,
}: {
  balance: number;
  positions: PaperPositionView[];
}) {
  const tickers = useMarketStore((state) => state.tickers);
  const btcPrice = tickers.BTCUSDT?.last ?? 0;
  const unrealized = positions.reduce((sum, position) => {
    const ticker = tickers[position.symbol];
    const mark = ticker?.last ?? position.entryPrice;
    const direction = position.side === "LONG" ? 1 : -1;
    return sum + (mark - position.entryPrice) * position.quantity * direction;
  }, 0);
  const equity = balance + unrealized;
  const positionValue = positions.reduce((sum, position) => {
    const ticker = tickers[position.symbol];
    const mark = ticker?.last ?? position.entryPrice;
    return sum + mark * position.quantity;
  }, 0);
  const cashPct = equity > 0 ? Math.max(0, Math.min(100, (balance / equity) * 100)) : 100;
  const exposurePct = equity > 0 ? Math.max(0, Math.min(100, (positionValue / equity) * 100)) : 0;

  return (
    <PageShell
      eyebrow="Portfolio"
      title="Paper Portfolio Analytics"
      description="Realtime equity, exposure, distribution, and performance analytics for the simulated trading account."
      action={<Badge variant="muted">Live marks</Badge>}
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        <MetricCard label="Total Equity" value={formatCurrency(equity)} detail="Balance + live PnL" icon={PieChart} tone="accent" />
        <MetricCard label="Unrealized PnL" value={formatCurrency(unrealized)} detail="Realtime mark" icon={TrendingUp} tone={unrealized >= 0 ? "bull" : "bear"} />
        <MetricCard label="Position Value" value={formatCurrency(positionValue)} detail={`${exposurePct.toFixed(1)}% exposure`} icon={BarChart3} tone="warn" />
        <MetricCard label="Open Positions" value={positions.length.toString()} detail="Database-backed" icon={Target} tone="muted" />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Card>
          <CardHeader>
            <CardTitle>Live Equity Curve Basis</CardTitle>
            <StatusBadge tone={unrealized >= 0 ? "bull" : "bear"}>{unrealized >= 0 ? "Positive" : "Negative"} PnL</StatusBadge>
          </CardHeader>
          <CardContent>
            <div className="h-[280px] rounded-lg border border-[var(--color-border)] bg-[linear-gradient(180deg,rgba(0,212,255,0.08),transparent)] p-5">
              <div className="flex h-full items-end justify-between gap-2">
                {[balance * 0.96, balance * 0.98, balance, equity].map((value, index) => (
                  <div key={`${value}-${index}`} className="flex flex-1 flex-col items-center gap-2">
                    <div className="w-full rounded-t bg-[var(--color-accent)]/75" style={{ height: `${Math.max(8, (value / Math.max(equity, balance)) * 90)}%` }} />
                    <span className="text-[10px] text-[var(--color-fg-subtle)]">{index === 3 ? "Live" : index + 1}</span>
                  </div>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        <aside className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Allocation</CardTitle>
              <Badge variant="muted">Realtime</Badge>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex h-3 overflow-hidden rounded-full bg-white/[0.04]">
                <span className="bg-[var(--color-accent)]" style={{ width: `${cashPct}%` }} />
                <span className="bg-[var(--color-bull)]" style={{ width: `${exposurePct}%` }} />
              </div>
              <AllocationRow label="Cash" value={cashPct} />
              <AllocationRow label="Open exposure" value={exposurePct} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Risk Exposure</CardTitle>
              <ShieldCheck className="size-4 text-[var(--color-bull)]" />
            </CardHeader>
            <CardContent className="space-y-2">
              <RiskRow label="Portfolio heat" value={`${exposurePct.toFixed(1)}%`} />
              <RiskRow label="BTC mark" value={btcPrice ? formatCurrency(btcPrice, "USDT") : "Connecting"} />
              <RiskRow label="Max live drawdown" value={unrealized < 0 ? formatCurrency(unrealized) : "0.00 USDT"} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Return Distribution</CardTitle></CardHeader>
            <CardContent>
              <MiniBars values={[cashPct, exposurePct, Math.abs(unrealized) + 1]} tone={unrealized >= 0 ? "bull" : "bear"} />
            </CardContent>
          </Card>
        </aside>
      </div>
    </PageShell>
  );
}

function AllocationRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-[var(--color-fg-muted)]">{label}</span>
      <span className="text-mono-tabular text-[var(--color-fg)]">{value.toFixed(1)}%</span>
    </div>
  );
}

function RiskRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between rounded-md bg-white/[0.025] px-3 py-2.5">
      <span className="text-sm text-[var(--color-fg-muted)]">{label}</span>
      <StatusBadge tone="muted">{value}</StatusBadge>
    </div>
  );
}
