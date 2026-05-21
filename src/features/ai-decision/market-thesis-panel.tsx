"use client";

import { AlertTriangle, BookOpen, BrainCog, Loader2, ShieldAlert } from "lucide-react";
import { formatDistanceToNowStrict } from "date-fns";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useAiThesisStore } from "@/store/ai-thesis-store";
import { useMarketStore } from "@/store/market-store";
import type { MarketBias, SetupQuality } from "@/services/ai/schemas";

/**
 * Renders the LLM's structured thesis for the active symbol. Read-only —
 * the AiThesisSubscriber is the only writer to the store.
 *
 * Three states: loading (first fetch, no cached entry), error (last fetch
 * failed AND no cached entry), and ready (any prior entry, even if a refresh
 * is in flight). We keep showing the last good thesis during a background
 * refresh so the panel doesn't flicker every 3 minutes.
 */
export function MarketThesisPanel() {
  const symbol = useMarketStore((s) => s.symbol);
  const entry = useAiThesisStore((s) => s.bySymbol[symbol]);
  const loading = useAiThesisStore((s) => s.loading[symbol]);
  const error = useAiThesisStore((s) => s.error[symbol]);

  return (
    <div className="panel overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-5 pt-4 pb-3 border-b border-[var(--border)]">
        <div className="flex items-center gap-2">
          <BrainCog className="size-4 text-[var(--accent)]" />
          <h3 className="text-[13px] font-semibold tracking-wide uppercase text-[var(--fg-muted)]">
            AI Market Thesis
          </h3>
        </div>
        <div className="flex items-center gap-2">
          {loading && <Loader2 className="size-3.5 animate-spin text-[var(--fg-subtle)]" />}
          {entry && (
            <Badge variant="muted">
              {formatDistanceToNowStrict(new Date(entry.generatedAt), { addSuffix: true })}
            </Badge>
          )}
        </div>
      </div>

      <div className="px-5 py-4 space-y-4">
        {!entry && loading && <SkeletonBody />}
        {!entry && !loading && error && <ErrorBody error={error} />}
        {!entry && !loading && !error && <EmptyBody />}
        {entry && (
          <>
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-1">
                <div className="text-[10px] uppercase tracking-wider text-[var(--fg-subtle)]">
                  Bias
                </div>
                <div className={cn("text-lg font-semibold capitalize", BIAS_TONE[entry.thesis.marketBias])}>
                  {entry.thesis.marketBias}
                </div>
              </div>
              <ConfidenceRing value={entry.thesis.confidence} />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <Tile label="Setup Quality">
                <span className={cn("text-xl font-bold", QUALITY_TONE[entry.thesis.setupQuality])}>
                  {entry.thesis.setupQuality}
                </span>
              </Tile>
            </div>

            <Section icon={BookOpen} title="Market Summary">
              {entry.thesis.summary}
            </Section>

            <Section icon={ShieldAlert} title="Risk Commentary" tone="warn">
              {entry.thesis.riskCommentary}
            </Section>

            <div className="rounded-md border border-[var(--accent)]/20 bg-[var(--accent-soft)] px-3 py-2.5">
              <div className="text-[10px] uppercase tracking-wider text-[var(--accent)] mb-1 font-bold">
                Trade Thesis
              </div>
              <p className="text-[13px] leading-relaxed text-[var(--fg)]">
                {entry.thesis.tradeThesis}
              </p>
            </div>

            {error && (
              <div className="flex items-center gap-2 text-[10px] text-[var(--color-warn)]">
                <AlertTriangle className="size-3" />
                <span>Refresh failed; showing last successful read.</span>
              </div>
            )}

            <p className="text-[10px] text-[var(--fg-subtle)] leading-relaxed italic border-t border-[var(--border)] pt-3">
              Analyst commentary, not financial advice. Probability-weighted.
              Paper simulation only.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

const BIAS_TONE: Record<MarketBias, string> = {
  "strongly bearish": "text-[var(--color-bear)]",
  "moderately bearish": "text-[var(--color-bear)]",
  neutral: "text-[var(--fg)]",
  "moderately bullish": "text-[var(--color-bull)]",
  "strongly bullish": "text-[var(--color-bull)]",
};

const QUALITY_TONE: Record<SetupQuality, string> = {
  "A+": "text-[var(--accent)]",
  A: "text-[var(--color-bull)]",
  "B+": "text-[var(--color-bull)]",
  B: "text-[var(--color-warn)]",
  C: "text-[var(--fg-muted)]",
  Avoid: "text-[var(--color-bear)]",
};

function Tile({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] p-3">
      <div className="text-[10px] uppercase tracking-wider text-[var(--fg-subtle)]">{label}</div>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function Section({
  icon: Icon,
  title,
  tone = "default",
  children,
}: {
  icon: React.ElementType;
  title: string;
  tone?: "default" | "warn";
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-[var(--fg-subtle)]">
        <Icon
          className={cn(
            "size-3",
            tone === "warn" ? "text-[var(--color-warn)]" : "text-[var(--accent)]",
          )}
        />
        {title}
      </div>
      <p className="text-[13px] leading-relaxed text-[var(--fg)]">{children}</p>
    </div>
  );
}

function SkeletonBody() {
  return (
    <div className="space-y-2">
      <div className="h-3 w-2/3 rounded bg-[var(--bg-elevated)] animate-pulse" />
      <div className="h-3 w-5/6 rounded bg-[var(--bg-elevated)] animate-pulse" />
      <div className="h-3 w-1/2 rounded bg-[var(--bg-elevated)] animate-pulse" />
      <div className="text-[10px] text-[var(--fg-subtle)] pt-2">
        Generating thesis…
      </div>
    </div>
  );
}

function ErrorBody({ error }: { error: string }) {
  return (
    <div className="rounded-md border border-[var(--color-warn)]/30 bg-[var(--color-warn-soft)] p-3 space-y-2">
      <div className="flex items-center gap-2 text-[var(--color-warn)] text-xs font-semibold">
        <AlertTriangle className="size-3.5" /> AI thesis unavailable
      </div>
      <p className="text-[11px] leading-5 text-[var(--fg-muted)] break-words">{error}</p>
      <p className="text-[10px] text-[var(--fg-subtle)]">
        Check GROQ_API_KEY in <code>.env</code> and the dev server logs.
      </p>
    </div>
  );
}

function EmptyBody() {
  return (
    <div className="text-xs text-[var(--fg-subtle)] leading-6">
      Awaiting first market snapshot. The thesis refreshes every ~3 minutes and on regime changes.
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
        ? "var(--accent)"
        : "var(--color-warn)";
  return (
    <div className="relative size-[64px] grid place-items-center">
      <svg viewBox="0 0 60 60" className="absolute inset-0 -rotate-90">
        <circle cx="30" cy="30" r={r} stroke="rgba(255,255,255,0.08)" strokeWidth="5" fill="none" />
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
        <div className="text-mono-tabular text-sm font-semibold leading-none">{pct}%</div>
        <div className="text-[9px] uppercase tracking-wider text-[var(--fg-subtle)] mt-0.5">
          AI Conf.
        </div>
      </div>
    </div>
  );
}
