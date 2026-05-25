"use client";

import { useState, useMemo } from "react";
import { isAfter, subDays, startOfDay, isSameDay, parseISO } from "date-fns";

import {
  BarChart3,
  Coins,
  ShieldCheck,
  Target,
  TrendingUp,
  TrendingDown,
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
import type { PaperPositionView, TradeHistoryView } from "@/types/portfolio";
import { computePositionRiskMetrics } from "@/lib/risk/metrics";

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
  tradeHistory,
}: {
  walletBalance: number;
  usedMargin: number;
  positions: PaperPositionView[];
  tradeHistory?: TradeHistoryView[];
}) {
  const tickers = useMarketStore((state) => state.tickers);
  const btcPrice = tickers.BTCUSDT?.last ?? 0;

  const unrealizedPnl = positions.reduce((sum, position) => {
    const ticker = tickers[position.symbol];
    const mark = ticker?.last ?? position.entryPrice;
    const metrics = computePositionRiskMetrics({
      side: position.side,
      entryPrice: position.entryPrice,
      quantity: position.quantity,
      leverage: position.leverage,
      currentPrice: mark,
    });
    return sum + metrics.unrealizedPnl;
  }, 0);

  const totalEquity = walletBalance + unrealizedPnl;
  const availableBalance = walletBalance - usedMargin;
  const grossNotional = positions.reduce((sum, position) => {
    const metrics = computePositionRiskMetrics({
      side: position.side,
      entryPrice: position.entryPrice,
      quantity: position.quantity,
      leverage: position.leverage,
    });
    return sum + metrics.notionalValue;
  }, 0);

  // Layout ratios use Total Equity as the denominator so the bars stay
  // sane even when wallet is split between margin and free cash.
  const denom = Math.max(totalEquity, 1);
  const marginPct = Math.max(0, Math.min(100, (usedMargin / denom) * 100));
  const cashPct = Math.max(0, Math.min(100, (availableBalance / denom) * 100));

  const [filter, setFilter] = useState<"ALL" | "TODAY" | "7D" | "30D" | "CUSTOM">("ALL");
  const [customDate, setCustomDate] = useState<string>("");
  const [sideFilter, setSideFilter] = useState<"ALL" | "LONG" | "SHORT">("ALL");

  const { totalProfit, totalLoss, netProfit } = useMemo(() => {
    if (!tradeHistory) return { totalProfit: 0, totalLoss: 0, netProfit: 0 };

    let filtered = tradeHistory;

    if (sideFilter !== "ALL") {
      filtered = filtered.filter((t) => t.side === sideFilter);
    }

    if (filter === "CUSTOM" && customDate) {
      const targetDate = parseISO(customDate);
      filtered = filtered.filter((t) => isSameDay(new Date(t.closedAt), targetDate));
    } else if (filter !== "ALL") {
      const now = new Date();
      let cutoff: Date | null = null;
      if (filter === "TODAY") cutoff = startOfDay(now);
      else if (filter === "7D") cutoff = subDays(now, 7);
      else if (filter === "30D") cutoff = subDays(now, 30);

      if (cutoff) {
        filtered = filtered.filter((t) => isAfter(new Date(t.closedAt), cutoff!));
      }
    }

    let tProfit = 0;
    let tLoss = 0;
    
    filtered.forEach(t => {
      if (t.pnl >= 0) tProfit += t.pnl;
      else tLoss += Math.abs(t.pnl);
    });

    return {
      totalProfit: tProfit,
      totalLoss: tLoss,
      netProfit: tProfit - tLoss,
    };
  }, [tradeHistory, filter, customDate]);

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

      <div className="flex items-center justify-between mt-10 mb-4">
        <h2 className="text-lg font-semibold tracking-tight text-[var(--fg)]">Historical Performance</h2>
        <div className="flex items-center gap-2">
          {filter === "CUSTOM" && (
            <input 
              type="date"
              value={customDate}
              onChange={(e) => setCustomDate(e.target.value)}
              className="h-8 text-xs rounded-md bg-[var(--surface-elevated)] border border-[var(--border)] text-[var(--fg)] px-2 focus:outline-none focus:border-[var(--accent)]"
            />
          )}
          <select
            value={sideFilter}
            onChange={(e) => setSideFilter(e.target.value as any)}
            className="w-[100px] h-8 text-xs rounded-md bg-[var(--surface-elevated)] border border-[var(--border)] text-[var(--fg)] px-2 focus:outline-none focus:border-[var(--accent)] cursor-pointer"
          >
            <option value="ALL">All Sides</option>
            <option value="LONG">Long</option>
            <option value="SHORT">Short</option>
          </select>
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as any)}
            className="w-[140px] h-8 text-xs rounded-md bg-[var(--surface-elevated)] border border-[var(--border)] text-[var(--fg)] px-2 focus:outline-none focus:border-[var(--accent)]"
          >
            <option value="ALL">All Time</option>
            <option value="TODAY">Today</option>
            <option value="7D">Last 7 Days</option>
            <option value="30D">Last 30 Days</option>
            <option value="CUSTOM">Custom Date</option>
          </select>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
        <MetricCard
          label="Total Profit"
          value={formatCurrency(totalProfit)}
          detail="Sum of winning trades"
          icon={TrendingUp}
          tone="bull"
        />
        <MetricCard
          label="Total Loss"
          value={formatCurrency(totalLoss)}
          detail="Sum of losing trades"
          icon={TrendingDown}
          tone="bear"
        />
        <MetricCard
          label="Net Profit"
          value={formatCurrency(netProfit)}
          detail="Profit minus Loss"
          icon={Coins}
          tone={netProfit >= 0 ? "bull" : "bear"}
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Allocation</CardTitle>
              <Badge variant="muted">Realtime</Badge>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex h-3 overflow-hidden rounded-full bg-[var(--surface-elevated)]">
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
    <div className="flex items-center justify-between rounded-md bg-[var(--surface-elevated)] px-3 py-2.5">
      <span className="text-sm text-[var(--fg-muted)]">{label}</span>
      <StatusBadge tone="muted">{value}</StatusBadge>
    </div>
  );
}
