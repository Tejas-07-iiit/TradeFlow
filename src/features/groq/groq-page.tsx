"use client";

import { useMemo } from "react";
import { AlertTriangle, BookOpen, BrainCog, Loader2, ShieldAlert } from "lucide-react";
import { formatDistanceToNowStrict } from "date-fns";

import { PageShell } from "@/components/shared/page-shell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SYMBOL_NAMES, WATCHLIST_SYMBOLS } from "@/lib/market/symbols";
import { cn, formatPrice } from "@/lib/utils";
import type {
  MarketBias,
  MarketDecision,
  MarketThesis,
  SetupQuality,
} from "@/services/ai/schemas";
import { LONG_DECISIONS, SHORT_DECISIONS } from "@/services/ai/schemas";
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
    const qualityFor = (s: string): SetupQuality | undefined =>
      decisions[s]?.decision.setupQuality ?? theses[s]?.thesis.setupQuality;
    return [...WATCHLIST_SYMBOLS].sort((a, b) => {
      const qa = qualityFor(a);
      const qb = qualityFor(b);
      if (!qa && !qb) return 0;
      if (!qa) return 1;
      if (!qb) return -1;
      return order.indexOf(qa) - order.indexOf(qb);
    });
  }, [theses, decisions]);

  // Count cards we can render. Under autonomy mode the decision subscriber
  // populates well before the thesis fan-out finishes, so we treat a
  // decision-only card as "ready" too — otherwise the dashboard sits at
  // 0/N for the first minute of every cold start.
  const generatedCount = WATCHLIST_SYMBOLS.filter(
    (s) => theses[s] != null || decisions[s] != null,
  ).length;

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
                  <div className="text-[11px] text-[var(--fg-subtle)]">
                    {ticker
                      ? `${formatPrice(ticker.last, ticker.last < 10 ? 4 : 2)} · ${ticker.changePct.toFixed(2)}% 24h`
                      : "Connecting"}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {loading && (
                    <Loader2 className="size-3.5 animate-spin text-[var(--fg-subtle)]" />
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
                {(() => {
                  const decisionEntry = decisions[sym];
                  // Synthesize a thesis-shaped view from the decision so the
                  // card renders under autonomy before the thesis fan-out
                  // has caught up.
                  const view = entry
                    ? thesisToView(entry.thesis)
                    : decisionEntry
                      ? decisionToView(decisionEntry.decision)
                      : null;
                  const displayConfidence =
                    decisionEntry?.decision.confidence ?? view?.confidence ?? 0;
                  const displayQuality =
                    decisionEntry?.decision.setupQuality ?? view?.setupQuality ?? "C";

                  if (!view) {
                    if (loading) return <Skeleton />;
                    if (error) return <ErrorView error={error} />;
                    return (
                      <p className="text-xs text-[var(--fg-subtle)]">
                        Awaiting first thesis fetch for this symbol.
                      </p>
                    );
                  }

                  return (
                    <>
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="text-[10px] uppercase tracking-wider text-[var(--fg-subtle)]">
                            Bias
                          </div>
                          <div
                            className={cn(
                              "text-base font-semibold capitalize",
                              BIAS_TONE[view.marketBias],
                            )}
                          >
                            {view.marketBias}
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          <div className="text-right">
                            <div className="text-[10px] uppercase tracking-wider text-[var(--fg-subtle)]">
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
                        {view.summary}
                      </Section>
                      <Section icon={ShieldAlert} title="Risk" tone="warn">
                        {view.riskCommentary}
                      </Section>
                      <div className="rounded-md border border-[var(--accent)]/20 bg-[var(--accent-soft)] px-3 py-2.5">
                        <div className="text-[10px] uppercase tracking-wider text-[var(--accent)] mb-1 font-bold">
                          Trade Thesis
                        </div>
                        <p className="text-[12px] leading-relaxed text-[var(--fg)]">
                          {view.tradeThesis}
                        </p>
                      </div>
                      {!entry && decisionEntry ? (
                        <p className="text-[10px] text-[var(--fg-subtle)] italic">
                          Showing live decision while the narrative thesis loads.
                        </p>
                      ) : null}
                      {error && (
                        <div className="flex items-center gap-2 text-[10px] text-[var(--color-warn)]">
                          <AlertTriangle className="size-3" />
                          <span>Last refresh failed; showing prior result.</span>
                        </div>
                      )}
                    </>
                  );
                })()}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </PageShell>
  );
}

/**
 * Shape the card actually renders from. Thesis is the natural shape;
 * decisions get mapped onto it when no thesis exists yet.
 */
interface CardView {
  marketBias: MarketBias;
  confidence: number;
  setupQuality: SetupQuality;
  summary: string;
  riskCommentary: string;
  tradeThesis: string;
}

function thesisToView(t: MarketThesis): CardView {
  return {
    marketBias: t.marketBias,
    confidence: t.confidence,
    setupQuality: t.setupQuality,
    summary: t.summary,
    riskCommentary: t.riskCommentary,
    tradeThesis: t.tradeThesis,
  };
}

function decisionToView(d: MarketDecision): CardView {
  const bias: MarketBias = LONG_DECISIONS.has(d.decision)
    ? d.confidence >= 75
      ? "strongly bullish"
      : "moderately bullish"
    : SHORT_DECISIONS.has(d.decision)
      ? d.confidence >= 75
        ? "strongly bearish"
        : "moderately bearish"
      : "neutral";
  const riskCommentary = d.warnings.length
    ? d.warnings.join(" ")
    : "No invalidation flagged by the engine for this snapshot.";
  const tradeThesisParts: string[] = [];
  if (d.executionRecommendation) tradeThesisParts.push(d.executionRecommendation);
  if (d.reasoning[0]) tradeThesisParts.push(d.reasoning[0]);
  if (d.executeTrade) {
    tradeThesisParts.push(
      `Entry ${formatPrice(d.entryPrice, d.entryPrice < 10 ? 4 : 2)} · TP ${formatPrice(d.takeProfit, d.takeProfit < 10 ? 4 : 2)} · SL ${formatPrice(d.stopLoss, d.stopLoss < 10 ? 4 : 2)} · size ${d.positionSizePercent}%`,
    );
  }
  const tradeThesis =
    tradeThesisParts.join(" — ").slice(0, 500) ||
    `Engine returned ${d.decision} with no actionable trade.`;
  return {
    marketBias: bias,
    confidence: d.confidence,
    setupQuality: d.setupQuality,
    summary: d.marketSummary,
    riskCommentary: riskCommentary.slice(0, 400),
    tradeThesis,
  };
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
      <p className="text-[12px] leading-relaxed text-[var(--fg)]">{children}</p>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="space-y-2">
      <div className="h-3 w-2/3 rounded bg-[var(--surface-elevated)] animate-pulse" />
      <div className="h-3 w-5/6 rounded bg-[var(--surface-elevated)] animate-pulse" />
      <div className="h-3 w-1/2 rounded bg-[var(--surface-elevated)] animate-pulse" />
      <div className="text-[10px] text-[var(--fg-subtle)] pt-2">Generating thesis…</div>
    </div>
  );
}

function ErrorView({ error }: { error: string }) {
  return (
    <div className="rounded-md border border-[var(--color-warn)]/30 bg-[var(--color-warn-soft)] p-3 space-y-2">
      <div className="flex items-center gap-2 text-[var(--color-warn)] text-xs font-semibold">
        <AlertTriangle className="size-3.5" /> Unavailable
      </div>
      <p className="text-[11px] leading-5 text-[var(--fg-muted)] break-words">{error}</p>
      <p className="text-[10px] text-[var(--fg-subtle)]">
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
    pct >= 70 ? "var(--color-bull)" : pct >= 45 ? "var(--accent)" : "var(--color-warn)";
  return (
    <div className="relative size-[52px] grid place-items-center">
      <svg viewBox="0 0 48 48" className="absolute inset-0 -rotate-90">
        <circle cx="24" cy="24" r={r} stroke="var(--ring-track)" strokeWidth="4" fill="none" />
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
