"use client";

import { Brain, CheckCircle2, Filter, LineChart, ShieldAlert, Sparkles } from "lucide-react";

import { MetricCard, PageShell, StatusBadge } from "@/components/shared/page-shell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { calculateIndicators, generateDecision } from "@/lib/signals/signal-engine";
import { cn } from "@/lib/utils";
import { EMPTY_ARRAY, useMarketStore } from "@/store/market-store";
import { useSignalStore } from "@/store/signal-store";
import { formatDistanceToNowStrict } from "date-fns";

export function LiveSignalsPage() {
  const symbol = useMarketStore((state) => state.symbol);
  const interval = useMarketStore((state) => state.interval);
  const allCandles = useMarketStore((state) => state.candles);
  const candles = allCandles[`${symbol}:${interval}`] ?? EMPTY_ARRAY;
  const decision = generateDecision(symbol, allCandles, interval);
  const indicators = calculateIndicators(candles);
  const signalHistory = useSignalStore((state) => state.history);
  const autoExec = useSignalStore((s) => s.autoExec[symbol]);

  const isAutoFired =
    !!autoExec &&
    (decision.signal === "BUY" || decision.signal === "SELL") &&
    autoExec.signal === decision.signal &&
    autoExec.type === decision.type;

  return (
    <PageShell
      eyebrow="AI Signals"
      title="Decision Intelligence Workspace"
      description="Realtime indicator-derived signals using EMA50, EMA200, RSI, ATR, ADX, and regime classification."
      action={<Badge variant="accent"><Sparkles className="size-3" /> Indicator engine</Badge>}
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        <MetricCard label="Active Signal" value={decision.signal} detail={decision.symbol} icon={Brain} tone={decision.signal === "BUY" ? "bull" : decision.signal === "SELL" ? "bear" : "muted"} />
        <MetricCard label="Confidence" value={`${decision.confidence}%`} detail="Rule weighted" icon={LineChart} tone="accent" />
        <MetricCard label="Risk Level" value={decision.risk} detail={indicators.atrPct ? `ATR ${indicators.atrPct.toFixed(2)}%` : "Calculating"} icon={ShieldAlert} tone={decision.risk === "High" ? "bear" : decision.risk === "Medium" ? "warn" : "bull"} />
        <MetricCard label="Regime" value={decision.marketCondition} detail={indicators.adx14 ? `ADX ${indicators.adx14.toFixed(1)}` : "Calculating"} icon={CheckCircle2} tone={decision.marketCondition.includes("Up") ? "bull" : decision.marketCondition.includes("Down") ? "bear" : "warn"} />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-4">
          <Card className="overflow-hidden">
            <CardHeader>
              <div>
                <CardTitle>{decision.signal} {decision.symbol.replace("USDT", "")}</CardTitle>
                <div className="mt-1 text-xs text-[var(--fg-subtle)]">
                  Recalculated from latest {interval.toUpperCase()} Binance candles
                </div>
              </div>
              <StatusBadge tone={decision.signal === "BUY" ? "bull" : decision.signal === "SELL" ? "bear" : "muted"}>
                {decision.signal}
              </StatusBadge>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
                <SignalStat label="EMA50" value={indicators.ema50 ? indicators.ema50.toFixed(2) : "—"} />
                <SignalStat label="EMA200" value={indicators.ema200 ? indicators.ema200.toFixed(2) : "—"} />
                <SignalStat label="RSI" value={indicators.rsi14 ? indicators.rsi14.toFixed(1) : "—"} />
                <SignalStat label="ATR%" value={indicators.atrPct ? indicators.atrPct.toFixed(2) : "—"} />
                <SignalStat label="ADX" value={indicators.adx14 ? indicators.adx14.toFixed(1) : "—"} />
              </div>

              <div>
                <div className="mb-2 text-[10px] uppercase tracking-wider text-[var(--fg-subtle)]">
                  Why this signal
                </div>
                <ul className="space-y-2">
                  {decision.reasons.map((reason) => (
                    <li key={reason} className="flex gap-2 text-sm leading-6 text-[var(--fg-muted)]">
                      <CheckCircle2 className="mt-1 size-3.5 shrink-0 text-[var(--color-bull)]" />
                      {reason}
                    </li>
                  ))}
                </ul>
              </div>

              {decision.warnings.length > 0 ? (
                <div className="rounded-md border border-[var(--color-warn)]/20 bg-[var(--color-warn-soft)] p-3 text-sm leading-6 text-[var(--fg)]">
                  {decision.warnings.join(" ")}
                </div>
              ) : null}

              {decision.signal !== "HOLD" && decision.entryPrice != null && (
                <div className="grid grid-cols-3 gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] p-3">
                  <SignalLevel label="Entry" value={decision.entryPrice} />
                  <SignalLevel label="Stop Loss" value={decision.stopLoss} tone="bear" />
                  <SignalLevel label="Take Profit" value={decision.takeProfit} tone="bull" />
                </div>
              )}

              <div
                className={cn(
                  "rounded-md border px-3 py-2.5 text-center text-[13px] font-semibold tracking-wide",
                  isAutoFired
                    ? decision.signal === "BUY"
                      ? "border-[var(--color-bull)]/30 bg-[var(--color-bull-soft)] text-[var(--color-bull)]"
                      : "border-[var(--color-bear)]/30 bg-[var(--color-bear-soft)] text-[var(--color-bear)]"
                    : "border-[var(--border)] bg-[var(--bg-elevated)] text-[var(--fg-muted)]",
                )}
              >
                {isAutoFired
                  ? `AI auto-executed ${decision.signal} · ${decision.type}`
                  : decision.signal === "HOLD"
                    ? "No actionable signal — engine waiting"
                    : `Awaiting transition · ${decision.signal} ${decision.type}`}
              </div>
              <p className="mt-2 text-[10px] text-center text-[var(--fg-subtle)] leading-relaxed">
                {process.env.NEXT_PUBLIC_AI_AUTONOMY === "on"
                  ? "LLM Autonomy is ON. These rule-based signals are fed to the Groq AI, which owns the final execution."
                  : "LLM Autonomy is OFF. The Rule Engine will auto-execute these signals once per transition."}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Signal History</CardTitle>
              <Badge variant="muted">Last 50</Badge>
            </CardHeader>
            <CardContent>
              {signalHistory.length === 0 ? (
                <div className="py-8 text-center text-sm text-[var(--fg-subtle)]">
                  No signals generated yet. Stay tuned for live market alerts.
                </div>
              ) : (
                <div className="space-y-2 max-h-[500px] overflow-y-auto pr-2">
                  {signalHistory.map((s, i) => (
                    <div key={`${s.generatedAt}-${i}`} className={cn("flex items-center justify-between rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] p-3", s.status === "EXPIRED" && "opacity-50")}>
                      <div className="flex items-center gap-4">
                        <StatusBadge tone={s.signal === "BUY" ? "bull" : s.signal === "SELL" ? "bear" : "muted"}>
                          {s.signal}
                        </StatusBadge>
                        <div>
                          <div className="text-sm font-medium text-[var(--fg)] flex items-center gap-2">
                            {s.symbol}
                            <Badge variant="muted" className="text-[9px] h-4 px-1 uppercase tracking-tighter">
                              {s.type.split(" ")[0]}
                            </Badge>
                          </div>
                          <div className="text-[10px] text-[var(--fg-subtle)] flex items-center gap-1">
                            {formatDistanceToNowStrict(new Date(s.generatedAt), { addSuffix: true })}
                            {s.status !== "ACTIVE" && <span className="uppercase font-bold">· {s.status}</span>}
                          </div>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-sm font-semibold text-[var(--fg)]">{s.confidence}%</div>
                        <div className="text-[10px] text-[var(--fg-subtle)]">Quality: {s.setupQuality}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <aside className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Filters</CardTitle>
              <Filter className="size-4 text-[var(--fg-muted)]" />
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              {[symbol, interval.toUpperCase(), decision.signal, decision.risk, decision.marketCondition].map((filter) => (
                <Badge key={filter} variant="muted">{filter}</Badge>
              ))}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Signal Quality</CardTitle>
              <Badge variant="accent">Live</Badge>
            </CardHeader>
            <CardContent className="space-y-2">
              {[
                ["Trend", indicators.ema50 && indicators.ema200 ? indicators.ema50 > indicators.ema200 ? "Bullish" : "Bearish" : "Pending"],
                ["Momentum", indicators.rsi14 ? indicators.rsi14 > 55 ? "Positive" : indicators.rsi14 < 45 ? "Negative" : "Neutral" : "Pending"],
                ["Strength", indicators.adx14 ? indicators.adx14 > 20 ? "Confirmed" : "Weak" : "Pending"],
              ].map(([label, value]) => (
                <div key={label} className="flex items-center justify-between rounded-md bg-[var(--bg-elevated)] px-3 py-2.5">
                  <span className="text-sm text-[var(--fg-muted)]">{label}</span>
                  <span className={cn("text-sm text-[var(--fg)]", value === "Bullish" || value === "Positive" || value === "Confirmed" ? "text-[var(--color-bull)]" : "")}>{value}</span>
                </div>
              ))}
            </CardContent>
          </Card>
        </aside>
      </div>
    </PageShell>
  );
}

function SignalStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] p-3">
      <div className="text-[10px] uppercase tracking-wider text-[var(--fg-subtle)]">{label}</div>
      <div className="mt-1 text-mono-tabular text-sm font-semibold text-[var(--fg)]">{value}</div>
    </div>
  );
}

function SignalLevel({
  label,
  value,
  tone = "muted",
}: {
  label: string;
  value?: number;
  tone?: "bull" | "bear" | "muted";
}) {
  return (
    <div className="text-center">
      <div className="text-[9px] uppercase tracking-wider text-[var(--fg-subtle)] mb-1">
        {label}
      </div>
      <div
        className={cn(
          "text-mono-tabular text-sm font-semibold tabular-nums",
          tone === "bull" && "text-[var(--color-bull)]",
          tone === "bear" && "text-[var(--color-bear)]",
          tone === "muted" && "text-[var(--fg)]",
        )}
      >
        {value != null
          ? value.toLocaleString(undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })
          : "—"}
      </div>
    </div>
  );
}
