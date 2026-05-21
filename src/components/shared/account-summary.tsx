"use client";

import { useMemo } from "react";
import {
  CircleDollarSign,
  Coins,
  Info,
  Lock,
  TrendingDown,
  TrendingUp,
  Wallet,
  Zap,
} from "lucide-react";

import { Card } from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAccountMetrics } from "@/hooks/use-position-metrics";
import { cn, formatCurrency } from "@/lib/utils";

/**
 * Professional futures-style account summary strip.
 *
 * Renders the six independent accounting numbers the engine maintains —
 *   Wallet Balance · Available Balance · Used Margin ·
 *   Unrealized PnL · Realized PnL · Total Equity
 * — each in its own cell with a tooltip explaining the relationship. A thin
 * "wallet composition" bar underneath visualises the available / used-margin
 * split so the operator can see at a glance whether the wallet is heavily
 * committed.
 *
 * Values come from the memoised `useAccountMetrics()` hook, which itself is
 * driven by the Zustand portfolio store + live market tickers. Re-renders are
 * scoped to the ticker tick rate and skip when no input has changed.
 */
type Tone = "accent" | "bull" | "bear" | "warn" | "muted";

interface MetricCellProps {
  label: string;
  value: string;
  tooltip: string;
  icon: React.ElementType;
  tone: Tone;
  formula?: string;
}

function MetricCell({
  label,
  value,
  tooltip,
  icon: Icon,
  tone,
  formula,
}: MetricCellProps) {
  const valueColor =
    tone === "bull"
      ? "text-[var(--color-bull)]"
      : tone === "bear"
        ? "text-[var(--color-bear)]"
        : "text-[var(--color-fg)]";

  const iconBg =
    tone === "accent"
      ? "border-[var(--color-accent)]/25 bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
      : tone === "bull"
        ? "border-[var(--color-bull)]/25 bg-[var(--color-bull-soft)] text-[var(--color-bull)]"
        : tone === "bear"
          ? "border-[var(--color-bear)]/25 bg-[var(--color-bear-soft)] text-[var(--color-bear)]"
          : tone === "warn"
            ? "border-[var(--color-warn,var(--color-accent))]/25 bg-[var(--color-warn-soft,var(--color-accent-soft))] text-[var(--color-warn,var(--color-accent))]"
            : "border-[var(--color-border)] bg-[var(--surface-elevated)] text-[var(--color-fg-muted)]";

  return (
    <div className="group flex items-start gap-3 px-4 py-3 first:pl-4 last:pr-4 min-w-0">
      <div
        className={cn(
          "grid size-9 shrink-0 place-items-center rounded-md border",
          iconBg,
        )}
      >
        <Icon className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)] truncate">
            {label}
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={`What is ${label}?`}
                className="text-[var(--color-fg-subtle)]/70 hover:text-[var(--color-fg-muted)] transition-colors"
              >
                <Info className="size-3" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-[260px] text-[11px] leading-relaxed">
              {tooltip}
              {formula ? (
                <div className="mt-1 pt-1 border-t border-[var(--color-border)] font-mono text-[10px] text-[var(--color-fg-subtle)]">
                  {formula}
                </div>
              ) : null}
            </TooltipContent>
          </Tooltip>
        </div>
        <div
          className={cn(
            "mt-1 text-mono-tabular text-base font-semibold tracking-tight tabular-nums truncate",
            valueColor,
          )}
        >
          {value}
        </div>
      </div>
    </div>
  );
}

export function AccountSummary({ className }: { className?: string }) {
  const account = useAccountMetrics();

  // Wallet composition: how much of the wallet is locked as margin. Clamped
  // to [0, 100] so the visual bar stays sane when a closed-PnL drawdown
  // briefly leaves usedMargin > walletBalance (transient between settlement
  // updates).
  const { marginPct, availablePct } = useMemo(() => {
    const total = Math.max(account.walletBalance, 1);
    const m = Math.max(0, Math.min(100, (account.usedMargin / total) * 100));
    return { marginPct: m, availablePct: 100 - m };
  }, [account.walletBalance, account.usedMargin]);

  const unrealizedTone: Tone =
    account.unrealizedPnl > 0 ? "bull" : account.unrealizedPnl < 0 ? "bear" : "muted";
  const realizedTone: Tone =
    account.realizedPnl > 0 ? "bull" : account.realizedPnl < 0 ? "bear" : "muted";

  return (
    <Card className={cn("overflow-hidden", className)}>
      <div className="grid grid-cols-2 divide-x divide-y divide-[var(--color-border)] md:grid-cols-3 md:divide-y-0 xl:grid-cols-6">
        <MetricCell
          label="Wallet Balance"
          value={formatCurrency(account.walletBalance, account.currency)}
          tooltip="Cleared cash on the account. Changes only when a position closes — opening a trade reserves margin but does not move this number."
          icon={Wallet}
          tone="accent"
        />
        <MetricCell
          label="Available"
          value={formatCurrency(account.availableBalance, account.currency)}
          tooltip="Free capital that can back new positions. Falls when margin is reserved, recovers when positions close."
          icon={Zap}
          tone={account.availableBalance > 0 ? "accent" : "bear"}
          formula="Available = Wallet − Used Margin"
        />
        <MetricCell
          label="Used Margin"
          value={formatCurrency(account.usedMargin, account.currency)}
          tooltip="Collateral locked against currently open positions. Released proportionally as positions close."
          icon={Lock}
          tone="warn"
          formula="Σ (notional / leverage) across open positions"
        />
        <MetricCell
          label="Unrealized PnL"
          value={formatCurrency(account.unrealizedPnl, account.currency)}
          tooltip="Live mark-to-market profit/loss on open positions. Updates with every market tick; only settles into wallet on close."
          icon={account.unrealizedPnl >= 0 ? TrendingUp : TrendingDown}
          tone={unrealizedTone}
          formula="LONG: (mark − entry)·qty  ·  SHORT: (entry − mark)·qty"
        />
        <MetricCell
          label="Realized PnL"
          value={formatCurrency(account.realizedPnl, account.currency)}
          tooltip="Running total of profit/loss from positions that have already closed. Persisted in trade history."
          icon={Coins}
          tone={realizedTone}
        />
        <MetricCell
          label="Total Equity"
          value={formatCurrency(account.totalEquity, account.currency)}
          tooltip="The number to watch. What the account would settle to if every position closed at the current mark."
          icon={CircleDollarSign}
          tone="accent"
          formula="Equity = Wallet + Unrealized PnL"
        />
      </div>

      <div className="px-4 py-2.5 border-t border-[var(--color-border)] bg-[var(--surface-elevated)]">
        <div className="flex items-center justify-between gap-3 text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1.5">
              <span className="size-1.5 rounded-full bg-[var(--color-accent)]" />
              Available {availablePct.toFixed(1)}%
            </span>
            <span className="flex items-center gap-1.5">
              <span className="size-1.5 rounded-full bg-[var(--color-warn,var(--color-accent))]" />
              Margin {marginPct.toFixed(1)}%
            </span>
          </div>
          <span className="text-[var(--color-fg-subtle)]/70">
            Wallet composition · {account.currency}
          </span>
        </div>
        <div className="mt-1.5 flex h-1.5 overflow-hidden rounded-full bg-[var(--progress-track)]">
          <span
            className="bg-[var(--color-accent)]"
            style={{ width: `${availablePct}%` }}
          />
          <span
            className="bg-[var(--color-warn,var(--color-accent))]"
            style={{ width: `${marginPct}%` }}
          />
        </div>
      </div>
    </Card>
  );
}
