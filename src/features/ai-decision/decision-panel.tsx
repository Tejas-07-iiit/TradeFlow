"use client";

import { useState, useTransition } from "react";
import {
  AlertTriangle,
  Brain,
  CheckCircle2,
  Clock,
  Layers,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Zap,
} from "lucide-react";
import { formatDistanceToNowStrict } from "date-fns";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { createPaperOrder } from "@/server/trading";
import type { AIDecision } from "@/types/ai-decision";

interface DecisionPanelProps {
  decision: AIDecision;
}

const SIGNAL_STYLE: Record<
  AIDecision["signal"],
  { label: string; tone: "bull" | "bear" | "muted"; icon: React.ElementType }
> = {
  BUY: { label: "BUY", tone: "bull", icon: TrendingUp },
  SELL: { label: "SELL", tone: "bear", icon: TrendingDown },
  HOLD: { label: "HOLD", tone: "muted", icon: Sparkles },
};

const RISK_TONE: Record<AIDecision["risk"], "bull" | "warn" | "bear"> = {
  Low: "bull",
  Medium: "warn",
  High: "bear",
};

const QUALITY_COLOR: Record<AIDecision["setupQuality"], string> = {
  "A+": "text-[var(--color-accent)]",
  A: "text-[var(--color-bull)]",
  B: "text-[var(--color-warn)]",
  C: "text-[var(--color-fg-muted)]",
};

export function DecisionPanel({ decision }: DecisionPanelProps) {
  const [isPending, startTransition] = useTransition();
  const signal = SIGNAL_STYLE[decision.signal];
  const SignalIcon = signal.icon;

  const isExpired = decision.status === "EXPIRED";

  const handleExecute = () => {
    if (!decision.entryPrice) return;
    
    startTransition(async () => {
      try {
        await createPaperOrder({
          symbol: decision.symbol,
          side: decision.signal === "BUY" ? "LONG" : "SHORT",
          type: "MARKET",
          quantity: decision.signal === "BUY" ? 0.025 : 0.025, // Mock quantity for now
          takeProfit: decision.takeProfit ?? undefined,
          stopLoss: decision.stopLoss ?? undefined,
        });
        toast.success("AI Signal executed successfully");
      } catch (error) {
        toast.error("Failed to execute signal");
      }
    });
  };

  return (
    <div className={cn("panel overflow-hidden transition-opacity", isExpired && "opacity-60 grayscale-[0.5]")}>
      <div className="flex items-center justify-between gap-3 px-5 pt-4 pb-3 border-b border-[var(--color-border)]">
        <div className="flex items-center gap-2">
          <Brain className="size-4 text-[var(--color-accent)]" />
          <h3 className="text-[13px] font-semibold tracking-wide uppercase text-[var(--color-fg-muted)]">
            AI Signal Intelligence
          </h3>
        </div>
        <div className="flex items-center gap-2">
          {decision.status !== "ACTIVE" && (
            <Badge variant="muted" className="text-[10px] h-5 px-1.5 uppercase font-bold">
              {decision.status}
            </Badge>
          )}
          <Badge variant="muted">
            {formatDistanceToNowStrict(new Date(decision.generatedAt), {
              addSuffix: true,
            })}
          </Badge>
        </div>
      </div>

      <div className="px-5 py-4 space-y-5">
        {/* Headline */}
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">
              <Zap className="size-3 text-[var(--color-accent)]" />
              {decision.type} · {decision.symbol}
            </div>
            <div
              className={cn(
                "flex items-center gap-2 text-2xl font-semibold tracking-tight",
                signal.tone === "bull" && "text-[var(--color-bull)]",
                signal.tone === "bear" && "text-[var(--color-bear)]",
                signal.tone === "muted" && "text-[var(--color-fg)]",
              )}
            >
              <SignalIcon className="size-5" />
              {signal.label} {decision.symbol.replace("USDT", "")}
            </div>
          </div>
          <div className="flex flex-col items-center">
            <ConfidenceRing value={decision.confidence} />
          </div>
        </div>

        {/* Intraday Metrics */}
        <div className="grid grid-cols-2 gap-2">
          <div className="flex flex-col rounded-md border border-[var(--color-border)] bg-white/[0.02] p-3">
            <div className="text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">Setup Quality</div>
            <div className={cn("mt-1 text-xl font-bold", QUALITY_COLOR[decision.setupQuality])}>
              {decision.setupQuality}
            </div>
          </div>
          <div className="flex flex-col rounded-md border border-[var(--color-border)] bg-white/[0.02] p-3">
            <div className="text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">Risk/Reward</div>
            <div className="mt-1 text-xl font-mono text-[var(--color-fg)]">
              1:{decision.rrRatio?.toFixed(1) ?? "—"}
            </div>
          </div>
        </div>

        {/* Trade Levels */}
        {decision.signal !== "HOLD" && decision.entryPrice && (
          <div className="grid grid-cols-3 gap-2 py-3 border-y border-[var(--color-border)] bg-white/[0.01]">
            <TradeLevel label="Entry" value={decision.entryPrice} tone="muted" />
            <TradeLevel label="Stop Loss" value={decision.stopLoss} tone="bear" />
            <TradeLevel label="Take Profit" value={decision.takeProfit} tone="bull" />
          </div>
        )}

        {/* Execution Action */}
        {decision.signal !== "HOLD" && !isExpired && (
          <div className="pt-1">
            <Button
              className="w-full h-10 font-bold tracking-tight"
              variant={decision.signal === "BUY" ? "bull" : "bear"}
              onClick={handleExecute}
              disabled={isPending}
            >
              {isPending ? "Executing..." : `EXECUTE AI ${decision.signal} SIGNAL`}
            </Button>
          </div>
        )}

        {/* Intraday Context */}
        <div className="grid grid-cols-2 gap-4 text-[11px]">
          <div className="flex items-center gap-2 text-[var(--color-fg-subtle)]">
            <Clock className="size-3" />
            <span>Hold: <strong>{decision.expectedHoldTime}</strong></span>
          </div>
          <div className="flex items-center gap-2 text-[var(--color-fg-subtle)]">
            <Layers className="size-3" />
            <span>Regime: <strong>{decision.marketCondition}</strong></span>
          </div>
        </div>

        {/* Reasons */}
        <div className="space-y-2">
          <SectionTitle>Technical Rationale</SectionTitle>
          <ul className="space-y-1.5">
            {decision.reasons.map((r) => (
              <li
                key={r}
                className="flex items-start gap-2 text-[13px] leading-relaxed text-[var(--color-fg)]"
              >
                <CheckCircle2 className="size-3.5 mt-0.5 text-[var(--color-bull)] shrink-0" />
                <span>{r}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* Warnings */}
        {decision.warnings.length > 0 ? (
          <div className="space-y-2">
            <SectionTitle>Watch outs</SectionTitle>
            <ul className="space-y-1.5">
              {decision.warnings.map((w) => (
                <li
                  key={w}
                  className="flex items-start gap-2 text-[13px] leading-relaxed text-[var(--color-fg-muted)]"
                >
                  <AlertTriangle className="size-3.5 mt-0.5 text-[var(--color-warn)] shrink-0" />
                  <span>{w}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {/* Verdict */}
        <div className="rounded-md border border-[var(--color-accent)]/20 bg-[var(--color-accent-soft)] px-3 py-2.5">
          <div className="text-[10px] uppercase tracking-wider text-[var(--color-accent)] mb-1 font-bold">
            Intraday Verdict
          </div>
          <p className="text-[13px] leading-relaxed text-[var(--color-fg)]">
            {decision.verdict}
          </p>
        </div>

        <p className="text-[10.5px] text-[var(--color-fg-subtle)] leading-relaxed italic border-t border-[var(--color-border)] pt-3">
          Signals expire after 60 minutes or upon trend invalidation.
          Manual paper execution only.
        </p>
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">
      {children}
    </div>
  );
}

function StatTile({
  label,
  tone,
  children,
}: {
  label: string;
  tone: "bull" | "bear" | "warn" | "muted";
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-white/[0.02] px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">
        {label}
      </div>
      <div
        className={cn(
          "mt-0.5 text-sm font-medium",
          tone === "bull" && "text-[var(--color-bull)]",
          tone === "bear" && "text-[var(--color-bear)]",
          tone === "warn" && "text-[var(--color-warn)]",
          tone === "muted" && "text-[var(--color-fg)]",
        )}
      >
        {children}
      </div>
    </div>
  );
}

function TradeLevel({
  label,
  value,
  tone,
}: {
  label: string;
  value?: number;
  tone: "bull" | "bear" | "muted";
}) {
  if (!value) return null;
  return (
    <div className="text-center">
      <div className="text-[9px] uppercase tracking-wider text-[var(--color-fg-subtle)] mb-1">
        {label}
      </div>
      <div
        className={cn(
          "text-mono-tabular text-xs font-semibold tabular-nums",
          tone === "bull" && "text-[var(--color-bull)]",
          tone === "bear" && "text-[var(--color-bear)]",
          tone === "muted" && "text-[var(--color-fg)]",
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

function ConfidenceRing({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(100, value));
  const r = 22;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - pct / 100);
  const color =
    pct >= 70
      ? "var(--color-bull)"
      : pct >= 45
        ? "var(--color-accent)"
        : "var(--color-warn)";
  return (
    <div className="relative size-[64px] grid place-items-center">
      <svg viewBox="0 0 60 60" className="absolute inset-0 -rotate-90">
        <circle
          cx="30"
          cy="30"
          r={r}
          stroke="rgba(255,255,255,0.08)"
          strokeWidth="5"
          fill="none"
        />
        <circle
          cx="30"
          cy="30"
          r={r}
          stroke={color}
          strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={offset}
          fill="none"
        />
      </svg>
      <div className="text-center">
        <div className="text-mono-tabular text-sm font-semibold leading-none">
          {pct}%
        </div>
        <div className="text-[9px] uppercase tracking-wider text-[var(--color-fg-subtle)] mt-0.5">
          Conf.
        </div>
      </div>
    </div>
  );
}
