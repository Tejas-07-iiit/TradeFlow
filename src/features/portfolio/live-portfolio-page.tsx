"use client";

import {
  BarChart3,
  Coins,
  ShieldCheck,
  Target,
} from "lucide-react";

import { AccountSummary } from "@/components/shared/account-summary";
import {
  MetricCard,
  MiniBars,
  PageShell,
  StatusBadge,
} from "@/components/shared/page-shell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";
import { useMarketStore } from "@/store/market-store";
import type { PaperPositionView } from "@/types/portfolio";

/**
 * Server-hydrated portfolio analytics view. The numbers here come from the
 * RSC route (wallet + positions) and are recomputed live against the market
 * tickers — wallet/usedMargin are SSR-fixed, but unrealizedPnL and totalEquity
 * track the mark in real time.
 */
export function LivePortfolioPage({
  walletBalance,
  usedMargin,
  positions,
}: {
  walletBalance: number;
  usedMargin: number;
  positions: PaperPositionView[];
}) {
  const tickers = useMarketStore((state) => state.tickers);
  const btcPrice = tickers.BTCUSDT?.last ?? 0;

  const unrealizedPnl = positions.reduce((sum, position) => {
    const ticker = tickers[position.symbol];
    const mark = ticker?.last ?? position.entryPrice;
    const direction = position.side === "LONG" ? 1 : -1;
    return sum + (mark - position.entryPrice) * position.quantity * direction;
  }, 0);

  const totalEquity = walletBalance + unrealizedPnl;
  const availableBalance = walletBalance - usedMargin;
  const grossNotional = positions.reduce((sum, position) => {
    return sum + position.entryPrice * position.quantity;
  }, 0);

  // Layout ratios use Total Equity as the denominator so the bars stay
  // sane even when wallet is split between margin and free cash.
  const denom = Math.max(totalEquity, 1);
  const marginPct = Math.max(0, Math.min(100, (usedMargin / denom) * 100));
  const cashPct = Math.max(0, Math.min(100, (availableBalance / denom) * 100));

  return (
    <PageShell
      eyebrow="Portfolio"
      title="Paper Portfolio Analytics"
      description="Wallet balance, used margin, unrealized PnL, and total equity — kept strictly separate, futures-style."
      action={<Badge variant="muted">Live marks</Badge>}
    >
      <AccountSummary />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <MetricCard
          label="Gross Notional"
          value={formatCurrency(grossNotional)}
          detail={`Across ${positions.length} open`}
          icon={BarChart3}
          tone="muted"
        />
        <MetricCard
          label="Open Positions"
          value={positions.length.toString()}
          detail="Database-backed"
          icon={Target}
          tone="muted"
        />
        <MetricCard
          label="Margin Utilisation"
          value={`${marginPct.toFixed(1)}%`}
          detail={`Avail ${formatCurrency(availableBalance)}`}
          icon={ShieldCheck}
          tone={marginPct > 80 ? "bear" : marginPct > 50 ? "warn" : "accent"}
        />
        <MetricCard
          label="Live Drawdown"
          value={
            unrealizedPnl < 0 ? formatCurrency(unrealizedPnl) : formatCurrency(0)
          }
          detail="From open positions"
          icon={Coins}
          tone={unrealizedPnl < 0 ? "bear" : "muted"}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Card>
          <CardHeader>
            <CardTitle>Equity vs Wallet</CardTitle>
            <StatusBadge tone={unrealizedPnl >= 0 ? "bull" : "bear"}>
              {unrealizedPnl >= 0 ? "Positive" : "Negative"} PnL
            </StatusBadge>
          </CardHeader>
          <CardContent>
            <div className="h-[280px] rounded-lg border border-[var(--border)] bg-[linear-gradient(180deg,rgba(0,212,255,0.08),transparent)] p-5">
              <div className="flex h-full items-end justify-between gap-2">
                {[
                  { label: "Wallet", value: walletBalance },
                  { label: "Avail", value: availableBalance },
                  { label: "Margin", value: usedMargin },
                  { label: "Equity", value: totalEquity },
                ].map((bar) => (
                  <div
                    key={bar.label}
                    className="flex flex-1 flex-col items-center gap-2"
                  >
                    <div
                      className="w-full rounded-t bg-[var(--accent)]/75"
                      style={{
                        height: `${Math.max(
                          8,
                          (Math.max(bar.value, 0) / Math.max(totalEquity, walletBalance, 1)) *
                            90,
                        )}%`,
                      }}
                    />
                    <span className="text-[10px] text-[var(--fg-subtle)]">
                      {bar.label}
                    </span>
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
              <div className="flex h-3 overflow-hidden rounded-full bg-[var(--bg-elevated)]">
                <span
                  className="bg-[var(--accent)]"
                  style={{ width: `${cashPct}%` }}
                />
                <span
                  className="bg-[var(--color-bull)]"
                  style={{ width: `${marginPct}%` }}
                />
              </div>
              <AllocationRow label="Available cash" value={cashPct} />
              <AllocationRow label="Used margin" value={marginPct} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Risk Exposure</CardTitle>
              <ShieldCheck className="size-4 text-[var(--color-bull)]" />
            </CardHeader>
            <CardContent className="space-y-2">
              <RiskRow
                label="Margin utilisation"
                value={`${marginPct.toFixed(1)}%`}
              />
              <RiskRow
                label="BTC mark"
                value={btcPrice ? formatCurrency(btcPrice, "USDT") : "Connecting"}
              />
              <RiskRow
                label="Live drawdown"
                value={
                  unrealizedPnl < 0 ? formatCurrency(unrealizedPnl) : "0.00 USDT"
                }
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Equity Distribution</CardTitle>
              <Coins className="size-4 text-[var(--fg-muted)]" />
            </CardHeader>
            <CardContent>
              <MiniBars
                values={[cashPct, marginPct, Math.abs(unrealizedPnl) + 1]}
                tone={unrealizedPnl >= 0 ? "bull" : "bear"}
              />
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
      <span className="text-[var(--fg-muted)]">{label}</span>
      <span className="text-mono-tabular text-[var(--fg)]">
        {value.toFixed(1)}%
      </span>
    </div>
  );
}

function RiskRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between rounded-md bg-[var(--bg-elevated)] px-3 py-2.5">
      <span className="text-sm text-[var(--fg-muted)]">{label}</span>
      <StatusBadge tone="muted">{value}</StatusBadge>
    </div>
  );
}
