"use client";

import { BrainCircuit, Gauge, RadioTower, Sparkles, Waves } from "lucide-react";

import { MetricCard, PageShell, StatusBadge } from "@/components/shared/page-shell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { calculateIndicators, generateDecision } from "@/lib/signals/signal-engine";
import { cn } from "@/lib/utils";
import { EMPTY_ARRAY, useMarketStore } from "@/store/market-store";

export function LiveInsightsPage() {
  const symbol = useMarketStore((state) => state.symbol);
  const interval = useMarketStore((state) => state.interval);
  const allCandles = useMarketStore((state) => state.candles);
  const candles = allCandles[`${symbol}:${interval}`] ?? EMPTY_ARRAY;
  const indicators = calculateIndicators(candles);
  const decision = generateDecision(symbol, allCandles, interval);

  const volatility =
    indicators.atrPct == null
      ? "Calculating"
      : indicators.atrPct > 3
        ? "High volatility"
        : indicators.atrPct > 1.5
          ? "Moderate expansion"
          : "Compressed";

  return (
    <PageShell
      eyebrow="AI Insights"
      title="Market Intelligence Terminal"
      description="Research-style market context generated from live EMA, RSI, ATR, ADX, and regime calculations."
      action={<Badge variant="accent"><BrainCircuit className="size-3" /> Live intelligence</Badge>}
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        <MetricCard label="Regime" value={indicators.regime} detail={indicators.adx14 ? `ADX ${indicators.adx14.toFixed(1)}` : "Calculating"} icon={Gauge} tone={indicators.regime.includes("Up") ? "bull" : indicators.regime.includes("Down") ? "bear" : "warn"} />
        <MetricCard label="Volatility" value={volatility} detail={indicators.atrPct ? `ATR ${indicators.atrPct.toFixed(2)}%` : "Calculating"} icon={Waves} tone={indicators.atrPct && indicators.atrPct > 3 ? "bear" : "warn"} />
        <MetricCard label="Signal Bias" value={decision.signal} detail={`${decision.confidence}% confidence`} icon={RadioTower} tone={decision.signal === "BUY" ? "bull" : decision.signal === "SELL" ? "bear" : "muted"} />
        <MetricCard label="Momentum" value={indicators.rsi14 ? `RSI ${indicators.rsi14.toFixed(1)}` : "Calculating"} detail="RSI(14)" icon={Sparkles} tone={indicators.rsi14 && indicators.rsi14 > 55 ? "bull" : indicators.rsi14 && indicators.rsi14 < 45 ? "bear" : "muted"} />
      </div>

      {decision.signal !== "HOLD" && (
        <Card className="mb-4 bg-[var(--accent-soft)] border-[var(--accent)]/20">
          <CardHeader>
            <CardTitle>Trade Execution Suggestion</CardTitle>
            <Badge variant="accent">Quant Parameters</Badge>
          </CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <TradeParam label="Suggested Entry" value={decision.entryPrice} />
            <TradeParam label="Risk Stop Loss" value={decision.stopLoss} tone="bear" />
            <TradeParam label="Profit Target" value={decision.takeProfit} tone="bull" />
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <InsightCard title="Market Regime" value={indicators.regime} tag="Live ADX/EMA" body={decision.reasons[0] ?? "Waiting for candle history."} />
          <InsightCard title="Volatility" value={volatility} tag="ATR(14)" body={decision.reasons.find((reason) => reason.includes("ATR")) ?? "ATR is calculating from live candle data."} />
          <InsightCard title="Momentum" value={decision.signal} tag="RSI/Trend" body={decision.reasons.find((reason) => reason.includes("RSI")) ?? "RSI is calculating from live candle data."} />
          <Card className="lg:col-span-3">
            <CardHeader>
              <CardTitle>Indicator Commentary</CardTitle>
              <Badge variant="muted">{interval.toUpperCase()} {symbol}</Badge>
            </CardHeader>
            <CardContent>
              <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-elevated)] p-5">
                <p className="max-w-4xl text-sm leading-7 text-[var(--fg-muted)]">
                  {decision.verdict} {decision.warnings.length > 0 ? decision.warnings.join(" ") : "No elevated indicator warnings are currently active."}
                </p>
              </div>
            </CardContent>
          </Card>
        </section>

        <aside>
          <Card>
            <CardHeader>
              <CardTitle>Analysis Feed</CardTitle>
              <Badge variant="accent">Realtime</Badge>
            </CardHeader>
            <CardContent className="space-y-3">
              {decision.reasons.map((reason) => (
                <article key={reason} className="rounded-md border border-[var(--border)] bg-[var(--surface-elevated)] p-3">
                  <div className="text-[10px] uppercase tracking-wider text-[var(--accent)]">Live indicator</div>
                  <p className="mt-2 text-xs leading-5 text-[var(--fg-muted)]">{reason}</p>
                </article>
              ))}
            </CardContent>
          </Card>
        </aside>
      </div>
    </PageShell>
  );
}

function InsightCard({
  title,
  value,
  tag,
  body,
}: {
  title: string;
  value: string;
  tag: string;
  body: string;
}) {
  return (
    <Card className="min-h-[240px]">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <StatusBadge tone="accent">{tag}</StatusBadge>
      </CardHeader>
      <CardContent>
        <div className="text-xl font-semibold tracking-tight text-[var(--fg)]">{value}</div>
        <p className="mt-4 text-sm leading-7 text-[var(--fg-muted)]">{body}</p>
      </CardContent>
    </Card>
  );
}

function TradeParam({
  label,
  value,
  tone = "muted",
}: {
  label: string;
  value?: number;
  tone?: "bull" | "bear" | "muted";
}) {
  if (!value) return null;
  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--surface-elevated)] p-3">
      <div className="text-[10px] uppercase tracking-wider text-[var(--fg-subtle)]">
        {label}
      </div>
      <div
        className={cn(
          "mt-1 text-mono-tabular text-lg font-semibold tabular-nums",
          tone === "bull" && "text-[var(--color-bull)]",
          tone === "bear" && "text-[var(--color-bear)]",
          tone === "muted" && "text-[var(--fg)]",
        )}
      >
        {value.toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}
      </div>
    </div>
  );
}
