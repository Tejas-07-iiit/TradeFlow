"use client";

import {
  Activity,
  BrainCog,
  Cpu,
  Zap,
} from "lucide-react";
import { formatDistanceToNowStrict } from "date-fns";

import { AccountSummary } from "@/components/shared/account-summary";
import {
  EmptyState,
  PageShell,
  StatusBadge,
} from "@/components/shared/page-shell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  formatDuration,
  usePositionMetrics,
} from "@/hooks/use-position-metrics";
import { cn, formatCurrency, formatPrice } from "@/lib/utils";
import { useAiDecisionStore } from "@/store/ai-decision-store";
import { useMarketStore } from "@/store/market-store";
import { usePortfolioStore } from "@/store/portfolio-store";
import type { CloseReasonView, DecisionSourceView } from "@/types/portfolio";

const CLOSE_REASON_LABEL: Record<CloseReasonView, string> = {
  MANUAL: "Manual",
  STOP_LOSS: "Stop Loss",
  TAKE_PROFIT: "Take Profit",
  EXPIRED: "Expired",
  LIQUIDATED: "Liquidated",
  AI_EXIT: "AI Exit",
};

const CLOSE_REASON_TONE: Record<CloseReasonView, "bull" | "bear" | "muted" | "accent"> = {
  MANUAL: "muted",
  STOP_LOSS: "bear",
  TAKE_PROFIT: "bull",
  EXPIRED: "muted",
  LIQUIDATED: "bear",
  AI_EXIT: "accent",
};

const SOURCE_LABEL: Record<DecisionSourceView, string> = {
  MANUAL: "Manual",
  RULE: "Rule",
  LLM: "LLM",
};

const SOURCE_TONE: Record<DecisionSourceView, "muted" | "warn" | "accent"> = {
  MANUAL: "muted",
  RULE: "warn",
  LLM: "accent",
};

const AUTONOMY_ON = process.env.NEXT_PUBLIC_AI_AUTONOMY === "on";

export function LivePaperTradingPage() {
  const symbol = useMarketStore((s) => s.symbol);

  const positions = usePortfolioStore((s) => s.positions);
  const orders = usePortfolioStore((s) => s.orders);
  const tradeHistory = usePortfolioStore((s) => s.tradeHistory);

  const executionLog = useAiDecisionStore((s) => s.executionLog);
  const llmDecisions = useAiDecisionStore((s) => s.bySymbol);

  const pendingOrders = orders.filter((o) => o.status === "PENDING");

  const portfolioMetrics = usePositionMetrics(positions);
  const { positions: enrichedPositions } = portfolioMetrics;

  const llmPositionsCount = positions.filter(
    (p) =>
      p.decisionSource === "LLM" &&
      (p.status === "OPEN" || p.status === "PARTIALLY_CLOSED"),
  ).length;

  const wins = tradeHistory.filter((t) => t.pnl > 0).length;
  const losses = tradeHistory.filter((t) => t.pnl < 0).length;
  const winRate = wins + losses > 0 ? (wins / (wins + losses)) * 100 : null;

  const activeLlmDecision = llmDecisions[symbol]?.decision;

  return (
    <PageShell
      eyebrow="Autonomous Paper Trading"
      title="AI Quant Simulation Workstation"
      description="The LLM analyzes the market, decides the trade, opens paper positions, manages risk, and closes them. No real exchange execution is wired."
      action={
        <Badge variant={AUTONOMY_ON ? "bull" : "warn"}>
          <Cpu className="size-3" />
          {AUTONOMY_ON ? "Autonomy Live" : "Autonomy Standby"}
        </Badge>
      }
    >
      <AccountSummary />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <SecondaryStat
          label="Open Positions"
          value={positions.length.toString()}
          detail={`${llmPositionsCount} LLM-owned`}
        />
        <SecondaryStat
          label="Pending Orders"
          value={pendingOrders.length.toString()}
          detail="Awaiting fill"
        />
        <SecondaryStat
          label="Closed Trades"
          value={tradeHistory.length.toString()}
          detail={`${wins}W · ${losses}L`}
        />
        <SecondaryStat
          label="Win Rate"
          value={winRate != null ? `${winRate.toFixed(1)}%` : "—"}
          detail={winRate != null && winRate >= 50 ? "Above breakeven" : "Building sample"}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[420px_minmax(0,1fr)]">
        <section className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <BrainCog className="size-4 text-[var(--color-accent)]" />
                Active LLM Decision
              </CardTitle>
              <Badge variant="muted">{symbol}</Badge>
            </CardHeader>
            <CardContent className="space-y-3">
              {!activeLlmDecision ? (
                <p className="text-xs text-[var(--color-fg-subtle)]">
                  Awaiting first decision for this symbol.
                </p>
              ) : (
                <>
                  <div className="flex items-center justify-between">
                    <StatusBadge
                      tone={
                        activeLlmDecision.executeTrade
                          ? activeLlmDecision.decision.toString().includes("SHORT") ||
                            activeLlmDecision.decision === "SELL"
                            ? "bear"
                            : "bull"
                          : "muted"
                      }
                    >
                      {activeLlmDecision.decision}
                    </StatusBadge>
                    <div className="flex items-center gap-2">
                      <Badge variant="accent">{activeLlmDecision.setupQuality}</Badge>
                      <Badge variant="muted">{activeLlmDecision.confidence}%</Badge>
                    </div>
                  </div>
                  <p className="text-[12px] leading-relaxed text-[var(--color-fg)]">
                    {activeLlmDecision.marketSummary}
                  </p>
                  <div className="grid grid-cols-3 gap-2 pt-1 text-[11px]">
                    <Metric
                      label="Entry"
                      value={formatPrice(activeLlmDecision.entryPrice)}
                    />
                    <Metric
                      label="TP"
                      value={formatPrice(activeLlmDecision.takeProfit)}
                      tone="bull"
                    />
                    <Metric
                      label="SL"
                      value={formatPrice(activeLlmDecision.stopLoss)}
                      tone="bear"
                    />
                  </div>
                  <ul className="space-y-1 pt-1">
                    {activeLlmDecision.reasoning.slice(0, 3).map((r) => (
                      <li
                        key={r}
                        className="text-[11px] text-[var(--color-fg-muted)] leading-snug before:content-['•'] before:mr-1.5 before:text-[var(--color-accent)]"
                      >
                        {r}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </CardContent>
          </Card>

          <Card className="flex-1 min-h-0 flex flex-col">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Zap className="size-4 text-[var(--color-accent)]" />
                AI Execution Log
              </CardTitle>
              <div className="flex items-center gap-1.5 text-[10px] text-[var(--color-fg-subtle)] uppercase tracking-wider">
                <Activity className="size-3 text-[var(--color-bull)]" />
                {executionLog.length} events
              </div>
            </CardHeader>
            <CardContent className="flex-1 overflow-y-auto min-h-0 pt-0">
              {executionLog.length === 0 ? (
                <div className="mt-3">
                  <EmptyState
                    title="No AI activity yet"
                    description={
                      AUTONOMY_ON
                        ? "The engine is live — once decisions arrive and clear the risk gates, they'll show here."
                        : "Set NEXT_PUBLIC_AI_AUTONOMY=on to let the LLM drive paper execution. Until then, only the rule engine fires."
                    }
                  />
                </div>
              ) : (
                <div className="mt-3 space-y-1.5">
                  {executionLog.map((e) => (
                    <div
                      key={e.id}
                      className={cn(
                        "rounded-md border px-2.5 py-2 space-y-1",
                        e.outcome === "executed"
                          ? "border-[var(--color-accent)]/30 bg-[var(--color-accent-soft)]"
                          : "border-[var(--color-border)] bg-white/[0.01]",
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <Badge
                            variant={e.outcome === "executed" ? "accent" : "muted"}
                            className="text-[9px] h-4 px-1.5"
                          >
                            {e.decision}
                          </Badge>
                          <span className="text-xs font-medium text-[var(--color-fg)]">
                            {e.symbol.replace("USDT", "")}
                          </span>
                          <Badge variant="muted" className="text-[9px] h-4 px-1">
                            {e.setupQuality} · {e.confidence}%
                          </Badge>
                        </div>
                        <span className="text-[10px] text-[var(--color-fg-subtle)] shrink-0">
                          {formatDistanceToNowStrict(e.at, { addSuffix: true })}
                        </span>
                      </div>
                      <p className="text-[11px] text-[var(--color-fg-muted)] leading-snug">
                        {e.outcome === "rejected"
                          ? `Rejected — ${e.rejectionReason ?? "no reason"}`
                          : e.headline || "Executed"}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </section>

        <section className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Open Positions</CardTitle>
              <Badge variant="muted">{positions.length} positions</Badge>
            </CardHeader>
            <CardContent className="space-y-2">
              {enrichedPositions.length === 0 ? (
                <EmptyState
                  title="No open positions"
                  description="The autonomous engine will populate this once an LLM decision clears the risk gates."
                />
              ) : (
                enrichedPositions.map(
                  ({
                    position,
                    mark,
                    unrealizedPnl: pnl,
                    unrealizedPnlPct,
                    durationMs,
                    riskReward,
                  }) => (
                    <div
                      key={position.id}
                      className="rounded-md border border-[var(--color-border)] bg-white/[0.02] p-3 space-y-2"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-semibold text-[var(--color-fg)]">
                            {position.symbol}
                          </span>
                          <Badge
                            variant={position.side === "LONG" ? "bull" : "bear"}
                            className="text-[10px]"
                          >
                            {position.side}
                          </Badge>
                          {position.leverage > 1 ? (
                            <Badge variant="warn" className="text-[10px]">
                              {position.leverage}x
                            </Badge>
                          ) : null}
                          <Badge
                            variant={SOURCE_TONE[position.decisionSource]}
                            className="text-[9px] h-4 px-1"
                          >
                            {SOURCE_LABEL[position.decisionSource]}
                          </Badge>
                        </div>
                        <div
                          className={cn(
                            "text-right text-sm font-mono tabular-nums leading-tight",
                            pnl >= 0
                              ? "text-[var(--color-bull)]"
                              : "text-[var(--color-bear)]",
                          )}
                        >
                          {formatCurrency(pnl)}
                          <span className="block text-[10px] text-[var(--color-fg-subtle)]">
                            {unrealizedPnlPct >= 0 ? "+" : ""}
                            {unrealizedPnlPct.toFixed(2)}% ROE
                          </span>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8 text-[11px]">
                        <div className="space-y-0.5">
                          <div className="text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">
                            Qty / Notional
                          </div>
                          <div className="mt-1 text-mono-tabular text-xs text-[var(--color-fg)]">
                            {position.quantity}
                            {position.status === "PARTIALLY_CLOSED"
                              ? ` / ${position.initialQuantity}`
                              : ""}
                            <span className="text-[10px] text-[var(--color-fg-subtle)] block">
                              {formatCurrency(position.quantity * position.entryPrice)}
                            </span>
                          </div>
                        </div>
                        <Cell label="Entry" value={formatPrice(position.entryPrice)} />
                        <Cell label="Mark" value={formatPrice(mark)} />
                        <Cell label="Margin" value={formatCurrency(position.marginUsed)} />
                        <Cell
                          label="Liq"
                          value={
                            position.liquidationPrice && Number.isFinite(position.liquidationPrice)
                              ? formatPrice(position.liquidationPrice)
                              : "—"
                          }
                        />
                        <Cell
                          label="TP / SL"
                          value={`${position.takeProfit ? formatPrice(position.takeProfit) : "—"} / ${
                            position.stopLoss ? formatPrice(position.stopLoss) : "—"
                          }`}
                        />
                        <Cell label="Held" value={formatDuration(durationMs)} />
                        <Cell
                          label="RR"
                          value={riskReward != null ? `${riskReward.toFixed(2)}:1` : "—"}
                        />
                      </div>
                    </div>
                  ),
                )
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Pending Orders</CardTitle>
              <Badge variant="muted">{pendingOrders.length} active</Badge>
            </CardHeader>
            <CardContent className="space-y-2">
              {pendingOrders.length === 0 ? (
                <EmptyState
                  title="No pending orders"
                  description="Autonomous market orders fill nearly instantly — anything visible here is a limit order still waiting on price."
                />
              ) : (
                pendingOrders.map((order) => (
                  <div
                    key={order.id}
                    className="flex items-center justify-between rounded-md bg-white/[0.025] px-3 py-2.5"
                  >
                    <div className="flex gap-3 items-center">
                      <Badge
                        variant={order.side === "LONG" ? "bull" : "bear"}
                        className="text-[10px]"
                      >
                        {order.side}
                      </Badge>
                      <div>
                        <div className="text-sm font-medium text-[var(--color-fg)]">
                          {order.symbol}
                        </div>
                        <div className="text-xs text-[var(--color-fg-subtle)]">
                          {order.orderType} · {order.quantity} @{" "}
                          {order.price ? formatPrice(order.price) : "MARKET"}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge
                        variant={SOURCE_TONE[order.decisionSource]}
                        className="text-[9px] h-4 px-1"
                      >
                        {SOURCE_LABEL[order.decisionSource]}
                      </Badge>
                      <Badge variant="muted">{order.status}</Badge>
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Trade History</CardTitle>
              <Badge variant="muted">{tradeHistory.length} closed</Badge>
            </CardHeader>
            <CardContent className="space-y-1.5">
              {tradeHistory.length === 0 ? (
                <div className="py-4 text-center text-xs text-[var(--color-fg-subtle)]">
                  No closed trades yet
                </div>
              ) : (
                tradeHistory.slice(0, 25).map((trade) => (
                  <div
                    key={trade.id}
                    className="flex items-center justify-between rounded-md bg-white/[0.01] px-3 py-2 border border-[var(--color-border)]"
                  >
                    <div className="flex gap-3 items-center min-w-0">
                      <div
                        className={cn(
                          "text-[10px] font-bold px-1 py-0.5 rounded",
                          trade.side === "LONG"
                            ? "text-[var(--color-bull)]"
                            : "text-[var(--color-bear)]",
                        )}
                      >
                        {trade.side}
                      </div>
                      <div className="min-w-0">
                        <div className="text-xs font-medium text-[var(--color-fg)]">
                          {trade.symbol}
                        </div>
                        <div className="text-[10px] text-[var(--color-fg-subtle)] flex items-center gap-2">
                          <span>
                            {trade.quantity} @ {formatPrice(trade.entryPrice)} →{" "}
                            {formatPrice(trade.exitPrice)}
                          </span>
                          <span className="text-[var(--color-fg-subtle)]/60">·</span>
                          <span>{formatDuration(trade.durationMs)}</span>
                          {trade.riskReward != null && (
                            <>
                              <span className="text-[var(--color-fg-subtle)]/60">·</span>
                              <span>RR {trade.riskReward.toFixed(2)}</span>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge
                        variant={SOURCE_TONE[trade.decisionSource]}
                        className="text-[9px] h-4 px-1"
                      >
                        {SOURCE_LABEL[trade.decisionSource]}
                      </Badge>
                      <Badge
                        variant={CLOSE_REASON_TONE[trade.closeReason]}
                        className="text-[9px] h-4 px-1"
                      >
                        {CLOSE_REASON_LABEL[trade.closeReason]}
                      </Badge>
                      <div
                        className={cn(
                          "text-xs font-mono text-mono-tabular w-20 text-right",
                          trade.pnl >= 0
                            ? "text-[var(--color-bull)]"
                            : "text-[var(--color-bear)]",
                        )}
                      >
                        {formatCurrency(trade.pnl)}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </section>
      </div>

      <p className="text-[10.5px] text-[var(--color-fg-subtle)] leading-relaxed italic text-center pt-2">
        Paper trading only — no real capital, no live exchange execution.
        Mark price streams from Binance Spot; execution is fully simulated.
        Toggle <code>NEXT_PUBLIC_AI_AUTONOMY</code> between <code>on</code> and{" "}
        <code>off</code> to hand the wheel between the LLM and the rule engine.
      </p>
    </PageShell>
  );
}

function Cell({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "bull" | "bear";
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">
        {label}
      </div>
      <div
        className={cn(
          "mt-1 text-mono-tabular text-xs",
          tone === "bull"
            ? "text-[var(--color-bull)]"
            : tone === "bear"
              ? "text-[var(--color-bear)]"
              : "text-[var(--color-fg)]",
        )}
      >
        {value}
      </div>
    </div>
  );
}

function SecondaryStat({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-white/[0.02] px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">
        {label}
      </div>
      <div className="mt-1 text-mono-tabular text-base font-semibold tabular-nums text-[var(--color-fg)]">
        {value}
      </div>
      {detail ? (
        <div className="mt-0.5 text-[10px] text-[var(--color-fg-subtle)] truncate">
          {detail}
        </div>
      ) : null}
    </div>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "bull" | "bear";
}) {
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-white/[0.02] p-2">
      <div className="text-[9px] uppercase tracking-wider text-[var(--color-fg-subtle)]">
        {label}
      </div>
      <div
        className={cn(
          "mt-0.5 text-mono-tabular font-semibold",
          tone === "bull"
            ? "text-[var(--color-bull)]"
            : tone === "bear"
              ? "text-[var(--color-bear)]"
              : "text-[var(--color-fg)]",
        )}
      >
        {value}
      </div>
    </div>
  );
}
