"use client";

import { useMemo } from "react";
import { AlertTriangle, BookOpen, BrainCog, Loader2, ShieldAlert } from "lucide-react";
import { formatDistanceToNowStrict } from "date-fns";

import { PageShell } from "@/components/shared/page-shell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SYMBOL_NAMES, WATCHLIST_SYMBOLS } from "@/lib/market/symbols";
import { cn, formatPrice } from "@/lib/utils";
import type { MarketBias, SetupQuality } from "@/services/ai/schemas";
import { useAiThesisStore } from "@/store/ai-thesis-store";
import { useMarketStore } from "@/store/market-store";
import { useSignalStore } from "@/store/signal-store";
import { useAiDecisionStore } from "@/store/ai-decision-store";

/**
 * Multi-symbol Groq thesis dashboard. One card per watchlist symbol.
 *
 * Reads from `ai-thesis-store` (populated by AiThesisSubscriber in the
 * platform layout). Sorts to surface the most actionable theses first:
 * `Avoid` and `C` setups sink to the bottom; A+ / A rise to the top.
 *
 * Auto-execution status comes from `signal-store.autoExec[symbol]` so the
 * user can see which symbols the engine has already opened positions on.
 */
export function GroqPage() {
  const theses = useAiThesisStore((s) => s.bySymbol);
  const loadingMap = useAiThesisStore((s) => s.loading);
  const errorMap = useAiThesisStore((s) => s.error);
  const tickers = useMarketStore((s) => s.tickers);
  const autoExec = useSignalStore((s) => s.autoExec);
  const decisions = useAiDecisionStore((s) => s.bySymbol);

  const sorted = useMemo(() => {
    const order: SetupQuality[] = ["A+", "A", "B+", "B", "C", "Avoid"];
    return [...WATCHLIST_SYMBOLS].sort((a, b) => {
      const qa = theses[a]?.thesis.setupQuality;
      const qb = theses[b]?.thesis.setupQuality;
      if (!qa && !qb) return 0;
      if (!qa) return 1;
      if (!qb) return -1;
      return order.indexOf(qa) - order.indexOf(qb);
    });
  }, [theses]);

  const generatedCount = Object.values(theses).filter(Boolean).length;

  return (
    <PageShell
      eyebrow="Groq AI"
      title="Market Reasoning Workstation"
      description="Live LLM analyst commentary across every watchlist symbol. Refreshes on a 3-minute round-robin and on regime changes. When autonomy is on, the LLM is the decision authority; otherwise this layer narrates."
      action={
        <Badge variant="accent">
          <BrainCog className="size-3" /> {generatedCount}/{WATCHLIST_SYMBOLS.length} theses ready
        </Badge>
      }
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {sorted.map((sym) => {
          const entry = theses[sym];
          const loading = loadingMap[sym];
          const error = errorMap[sym];
          const ticker = tickers[sym];
          const exec = autoExec[sym];
          return (
            <Card key={sym} className="overflow-hidden">
              <CardHeader>
                <div className="space-y-0.5">
                  <CardTitle className="flex items-center gap-2">
                    <span>{sym}</span>
                    <Badge variant="muted" className="text-[9px] h-4 px-1.5">
                      {SYMBOL_NAMES[sym] ?? sym}
                    </Badge>
                  </CardTitle>
                  <div className="text-[11px] text-[var(--color-fg-subtle)]">
                    {ticker
                      ? `${formatPrice(ticker.last, ticker.last < 10 ? 4 : 2)} · ${ticker.changePct.toFixed(2)}% 24h`
                      : "Connecting"}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {loading && (
                    <Loader2 className="size-3.5 animate-spin text-[var(--color-fg-subtle)]" />
                  )}
                  {entry && (
                    <Badge variant="muted">
                      {formatDistanceToNowStrict(new Date(entry.generatedAt), {
                        addSuffix: true,
                      })}
                    </Badge>
                  )}
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {!entry && loading && <Skeleton />}
                {!entry && !loading && error && <ErrorView error={error} />}
                {!entry && !loading && !error && (
                  <p className="text-xs text-[var(--color-fg-subtle)]">
                    Awaiting first thesis fetch for this symbol.
                  </p>
                )}
                {entry && (() => {
                  const decisionEntry = decisions[sym];
                  const displayConfidence = decisionEntry?.decision.confidence ?? entry.thesis.confidence;
                  const displayQuality = decisionEntry?.decision.setupQuality ?? entry.thesis.setupQuality;
                  
                  return (
                  <>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">
                          Bias
                        </div>
                        <div
                          className={cn(
                            "text-base font-semibold capitalize",
                            BIAS_TONE[entry.thesis.marketBias],
                          )}
                        >
                          {entry.thesis.marketBias}
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="text-right">
                          <div className="text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">
                            Setup
                          </div>
                          <div
                            className={cn(
                              "text-lg font-bold leading-none mt-0.5",
                              QUALITY_TONE[displayQuality],
                            )}
                          >
                            {displayQuality}
                          </div>
                        </div>
                        <ConfidenceRing value={displayConfidence} />
                      </div>
                    </div>

                    {exec ? (
                      <Badge
                        variant={exec.signal === "BUY" ? "bull" : "bear"}
                        className="text-[10px]"
                      >
                        AI auto-fired {exec.signal} · {exec.type}
                      </Badge>
                    ) : null}

                    <Section icon={BookOpen} title="Summary">
                      {entry.thesis.summary}
                    </Section>
                    <Section icon={ShieldAlert} title="Risk" tone="warn">
                      {entry.thesis.riskCommentary}
                    </Section>
                    <div className="rounded-md border border-[var(--color-accent)]/20 bg-[var(--color-accent-soft)] px-3 py-2.5">
                      <div className="text-[10px] uppercase tracking-wider text-[var(--color-accent)] mb-1 font-bold">
                        Trade Thesis
                      </div>
                      <p className="text-[12px] leading-relaxed text-[var(--color-fg)]">
                        {entry.thesis.tradeThesis}
                      </p>
                    </div>
                    {error && (
                      <div className="flex items-center gap-2 text-[10px] text-[var(--color-warn)]">
                        <AlertTriangle className="size-3" />
                        <span>Last refresh failed; showing prior thesis.</span>
                      </div>
                    )}
                  </>
                )})}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </PageShell>
  );
}

const BIAS_TONE: Record<MarketBias, string> = {
  "strongly bearish": "text-[var(--color-bear)]",
  "moderately bearish": "text-[var(--color-bear)]",
  neutral: "text-[var(--color-fg)]",
  "moderately bullish": "text-[var(--color-bull)]",
  "strongly bullish": "text-[var(--color-bull)]",
};

const QUALITY_TONE: Record<SetupQuality, string> = {
  "A+": "text-[var(--color-accent)]",
  A: "text-[var(--color-bull)]",
  "B+": "text-[var(--color-bull)]",
  B: "text-[var(--color-warn)]",
  C: "text-[var(--color-fg-muted)]",
  Avoid: "text-[var(--color-bear)]",
};

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
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">
        <Icon
          className={cn(
            "size-3",
            tone === "warn" ? "text-[var(--color-warn)]" : "text-[var(--color-accent)]",
          )}
        />
        {title}
      </div>
      <p className="text-[12px] leading-relaxed text-[var(--color-fg)]">{children}</p>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="space-y-2">
      <div className="h-3 w-2/3 rounded bg-white/[0.06] animate-pulse" />
      <div className="h-3 w-5/6 rounded bg-white/[0.06] animate-pulse" />
      <div className="h-3 w-1/2 rounded bg-white/[0.06] animate-pulse" />
      <div className="text-[10px] text-[var(--color-fg-subtle)] pt-2">Generating thesis…</div>
    </div>
  );
}

function ErrorView({ error }: { error: string }) {
  return (
    <div className="rounded-md border border-[var(--color-warn)]/30 bg-[var(--color-warn-soft)] p-3 space-y-2">
      <div className="flex items-center gap-2 text-[var(--color-warn)] text-xs font-semibold">
        <AlertTriangle className="size-3.5" /> Unavailable
      </div>
      <p className="text-[11px] leading-5 text-[var(--color-fg-muted)] break-words">{error}</p>
      <p className="text-[10px] text-[var(--color-fg-subtle)]">
        Verify <code>GROQ_API_KEY</code> in <code>.env</code> and restart the dev server.
      </p>
    </div>
  );
}

function ConfidenceRing({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(100, value));
  const r = 18;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - pct / 100);
  const color =
    pct >= 70 ? "var(--color-bull)" : pct >= 45 ? "var(--color-accent)" : "var(--color-warn)";
  return (
    <div className="relative size-[52px] grid place-items-center">
      <svg viewBox="0 0 48 48" className="absolute inset-0 -rotate-90">
        <circle cx="24" cy="24" r={r} stroke="rgba(255,255,255,0.08)" strokeWidth="4" fill="none" />
        <circle
          cx="24"
          cy="24"
          r={r}
          stroke={color}
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={offset}
          fill="none"
        />
      </svg>
      <div className="text-center">
        <div className="text-mono-tabular text-xs font-semibold leading-none">{pct}%</div>
      </div>
    </div>
  );
}
