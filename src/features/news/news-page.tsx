"use client";

import { useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Gauge,
  MessageSquare,
  Newspaper,
  Sparkles,
  TrendingUp,
} from "lucide-react";
import { formatDistanceToNowStrict } from "date-fns";

import {
  EmptyState,
  MetricCard,
  PageShell,
} from "@/components/shared/page-shell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SYMBOL_NAMES, WATCHLIST_SYMBOLS } from "@/lib/market/symbols";
import { cn } from "@/lib/utils";
import type { FeedItem, Mood, SourceStatus } from "@/services/news";
import { useNewsStore } from "@/store/news-store";

const MOOD_TONE: Record<Mood, "bull" | "bear" | "warn" | "muted"> = {
  "very bearish": "bear",
  bearish: "bear",
  neutral: "muted",
  bullish: "bull",
  "very bullish": "bull",
};

const FNG_TONE = (value: number): "bull" | "bear" | "warn" | "accent" => {
  if (value <= 24) return "bear";
  if (value <= 44) return "warn";
  if (value <= 55) return "accent";
  if (value <= 74) return "bull";
  return "bull";
};

export function NewsPage() {
  const feed = useNewsStore((s) => s.feed);
  const loading = useNewsStore((s) => s.loading);
  const error = useNewsStore((s) => s.error);

  const [symbolFilter, setSymbolFilter] = useState<string | null>(null);

  const filteredItems = useMemo(() => {
    if (!feed) return [];
    return feed.items.filter((it) => {
      if (symbolFilter && !it.mentions.includes(symbolFilter as never)) return false;
      return true;
    });
  }, [feed, symbolFilter]);

  const redditItems = filteredItems.filter((i) => i.source === "reddit");
  const ccItems = filteredItems.filter((i) => i.source === "cryptocompare");

  const pulse = feed?.pulse;

  const marqueeItems = useMemo(() => {
    if (!feed) return [];
    return feed.items.slice(0, 15);
  }, [feed]);

  return (
    <PageShell
      eyebrow="Market News"
      title="What People Are Talking About"
      description="Live crypto headlines, social chatter, and market mood — refreshed every 5 minutes. The autonomous engine fuses the same sentiment into its trade decisions."
      action={
        <div className="flex items-center gap-2">
          <style dangerouslySetInnerHTML={{ __html: `
            @keyframes marquee {
              0% { transform: translateX(0); }
              100% { transform: translateX(-50%); }
            }
            .animate-marquee {
              animation: marquee 60s linear infinite;
            }
          `}} />
          <Badge variant="muted">
          <Activity className="size-3" />
          {feed
            ? `Updated ${formatDistanceToNowStrict(feed.fetchedAt * 1000, { addSuffix: true })}`
            : loading
              ? "Loading"
              : "Standby"}
        </Badge>
        </div>
      }
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <MetricCard
          label="Fear & Greed"
          value={pulse?.fearGreed ? `${pulse.fearGreed.value}` : "—"}
          detail={pulse?.fearGreed?.classification ?? "Awaiting feed"}
          icon={Gauge}
          tone={pulse?.fearGreed ? FNG_TONE(pulse.fearGreed.value) : "muted"}
        />
        <MetricCard
          label="Reddit Mood"
          value={pulse ? labelMood(pulse.redditMood) : "—"}
          detail="From r/CryptoCurrency post flair distribution"
          icon={MessageSquare}
          tone={pulse ? MOOD_TONE[pulse.redditMood] : "muted"}
        />
        <MetricCard
          label="News Mood"
          value={pulse ? labelMood(pulse.newsMood) : "—"}
          detail="From CryptoCompare article vote distribution"
          icon={Newspaper}
          tone={pulse ? MOOD_TONE[pulse.newsMood] : "muted"}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TrendingUp className="size-4 text-[var(--color-accent)]" />
            Trending Tickers
          </CardTitle>
          <Badge variant="muted">
            {feed?.trending.reduce((a, b) => a + b.mentions, 0) ?? 0} mentions
          </Badge>
        </CardHeader>
        <CardContent>
          {!feed?.trending.length ? (
            <p className="text-xs text-[var(--color-fg-subtle)]">
              No watchlist symbols mentioned in the latest feed.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              <FilterChip
                label="All"
                count={feed.items.length}
                active={symbolFilter === null}
                onClick={() => setSymbolFilter(null)}
              />
              {feed.trending.map((t) => (
                <FilterChip
                  key={t.symbol}
                  label={`${t.symbol.replace("USDT", "")} · ${SYMBOL_NAMES[t.symbol] ?? ""}`.trim()}
                  count={t.mentions}
                  active={symbolFilter === t.symbol}
                  onClick={() =>
                    setSymbolFilter(symbolFilter === t.symbol ? null : t.symbol)
                  }
                />
              ))}
              {WATCHLIST_SYMBOLS.filter(
                (s) => !feed.trending.some((t) => t.symbol === s),
              ).map((s) => (
                <FilterChip
                  key={s}
                  label={s.replace("USDT", "")}
                  count={0}
                  active={symbolFilter === s}
                  onClick={() => setSymbolFilter(symbolFilter === s ? null : s)}
                  dim
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>



      {/* Horizontal Scrolling Marquee */}
      {feed && marqueeItems.length > 0 && (
        <div className="relative overflow-hidden flex items-center bg-white/[0.02] border border-[var(--color-border)] rounded-xl py-3 mt-2">
           <div className="absolute left-0 w-16 h-full bg-gradient-to-r from-[var(--color-bg)] to-transparent z-10 pointer-events-none" />
           <div className="absolute right-0 w-16 h-full bg-gradient-to-l from-[var(--color-bg)] to-transparent z-10 pointer-events-none" />
           <div className="flex whitespace-nowrap animate-marquee hover:[animation-play-state:paused] w-max">
             <div className="flex shrink-0 items-center">
               {marqueeItems.map((it, idx) => (
                  <a key={`${it.id}-${idx}`} href={it.url} target="_blank" rel="noopener noreferrer" className="mx-6 flex items-center gap-2 hover:text-white transition-colors">
                    <Badge variant="accent" className="text-[9px] h-4 px-1.5 bg-[var(--color-accent)]/10 text-[var(--color-accent)] border-none">
                      {it.sourceLabel}
                    </Badge>
                    <span className="text-[13px] font-medium text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]">
                      {it.title}
                    </span>
                    <span className="text-[var(--color-border)] mx-6">•</span>
                  </a>
               ))}
             </div>
             <div className="flex shrink-0 items-center">
               {marqueeItems.map((it, idx) => (
                  <a key={`${it.id}-dup-${idx}`} href={it.url} target="_blank" rel="noopener noreferrer" className="mx-6 flex items-center gap-2 hover:text-white transition-colors">
                    <Badge variant="accent" className="text-[9px] h-4 px-1.5 bg-[var(--color-accent)]/10 text-[var(--color-accent)] border-none">
                      {it.sourceLabel}
                    </Badge>
                    <span className="text-[13px] font-medium text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]">
                      {it.title}
                    </span>
                    <span className="text-[var(--color-border)] mx-6">•</span>
                  </a>
               ))}
             </div>
           </div>
        </div>
      )}

      {/* Grid of all items */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 mt-4">
        {!feed ? (
          error ? (
            <div className="col-span-full"><ErrorState error={error} /></div>
          ) : (
            <SkeletonRows />
          )
        ) : filteredItems.length === 0 ? (
          <div className="col-span-full space-y-3">
            <EmptyState
              title="No items found"
              description="Try removing the symbol filter or check back in a few minutes."
            />
            {feed.sources?.some((s) => s.status !== "ok") && (
              <SourceFailures sources={feed.sources} />
            )}
          </div>
        ) : (
          filteredItems.slice(0, 40).map((it) => 
            it.source === "reddit" ? <RedditRow key={it.id} item={it} /> : <NewsRow key={it.id} item={it} />
          )
        )}
      </div>

      <p className="text-[10.5px] text-[var(--color-fg-subtle)] leading-relaxed italic text-center pt-2">
        News and community sentiment for context only — the autonomous engine
        treats them as one of many inputs, never a guarantee. Sources:
        CryptoCompare News, r/CryptoCurrency, alternative.me Fear &amp; Greed.
      </p>
    </PageShell>
  );
}

function labelMood(mood: Mood): string {
  return mood.replace(/^./, (c) => c.toUpperCase());
}

const SOURCE_LABEL: Record<SourceStatus["source"], string> = {
  cryptocompare: "CryptoCompare",
  reddit: "r/CryptoCurrency",
};

function SourceFailures({ sources }: { sources: SourceStatus[] }) {
  const bad = sources.filter((s) => s.status !== "ok");
  if (bad.length === 0) return null;
  return (
    <div className="rounded-md border border-[var(--color-warn)]/30 bg-[var(--color-warn-soft)] p-3 space-y-2">
      <div className="flex items-center gap-2 text-[var(--color-warn)] text-xs font-semibold">
        <AlertTriangle className="size-3.5" /> Some news sources are unavailable
      </div>
      <ul className="space-y-1">
        {bad.map((s) => (
          <li
            key={s.source}
            className="text-[11px] leading-5 text-[var(--color-fg-muted)] break-words"
          >
            <span className="font-medium text-[var(--color-fg)]">
              {SOURCE_LABEL[s.source]}
            </span>{" "}
            — {s.status === "stale" ? "showing cached items, " : ""}
            {s.error ?? "no items returned"}
          </li>
        ))}
      </ul>
      <p className="text-[10px] text-[var(--color-fg-subtle)]">
        Reddit often rate-limits data-center IPs (AWS, GCP). CryptoCompare
        usually works; set <code>CRYPTOCOMPARE_API_KEY</code> in env if you
        see persistent 429s.
      </p>
    </div>
  );
}

function RedditRow({ item }: { item: FeedItem }) {
  return (
    <a
      href={item.url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex flex-col rounded-2xl border border-[var(--color-border)] bg-white/[0.01] hover:bg-[var(--color-accent-soft)] hover:border-[var(--color-accent)]/30 overflow-hidden transition-all duration-200 group min-h-[160px]"
    >
      <div className="p-4 flex flex-col flex-1 gap-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-1.5 flex-wrap">
            {item.sourceLabel ? (
              <Badge variant="accent" className="text-[9px] h-5 px-1.5 rounded-sm bg-[var(--color-accent)]/10 text-[var(--color-accent)] border-none">
                {item.sourceLabel}
              </Badge>
            ) : null}
            {item.mentions.map((m) => (
              <Badge key={m} variant="muted" className="text-[9px] h-5 px-1.5 rounded-sm">
                {m.replace("USDT", "")}
              </Badge>
            ))}
          </div>
          <div className="text-[10px] text-[var(--color-fg-subtle)] shrink-0">
            {formatDistanceToNowStrict(item.publishedAt * 1000, { addSuffix: true })}
          </div>
        </div>
        <div className="flex-1 space-y-2">
          <p className="text-[15px] font-semibold leading-snug text-[var(--color-fg)] group-hover:text-white transition-colors line-clamp-3">
            {item.title}
          </p>
          {item.excerpt ? (
            <p className="text-[12px] leading-relaxed text-[var(--color-fg-muted)] line-clamp-3">
              {item.excerpt}
            </p>
          ) : null}
        </div>
        <div className="flex items-center justify-between pt-3 mt-2 border-t border-[var(--color-border)]/50">
          <div className="flex items-center gap-4 text-[11px] text-[var(--color-fg-subtle)] font-medium">
            <div className="flex items-center gap-1 text-[var(--color-bull)]">
              ▲ {formatScore(item.score)}
            </div>
            <div className="flex items-center gap-1">
              <MessageSquare className="size-3" /> {item.comments ?? 0}
            </div>
          </div>
        </div>
      </div>
    </a>
  );
}

function NewsRow({ item }: { item: FeedItem }) {
  return (
    <a
      href={item.url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex flex-col rounded-2xl border border-[var(--color-border)] bg-white/[0.01] hover:bg-[var(--color-accent-soft)] hover:border-[var(--color-accent)]/30 overflow-hidden transition-all duration-200 group min-h-[220px]"
    >
      {item.imageUrl ? (
        <div className="w-full h-40 overflow-hidden shrink-0 border-b border-[var(--color-border)] bg-[var(--color-bg)]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={item.imageUrl}
            alt=""
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
            loading="lazy"
          />
        </div>
      ) : null}
      <div className="p-4 flex flex-col flex-1 gap-3">
        <div className="space-y-2 mb-2">
          <p className="text-[15px] font-semibold leading-snug text-[var(--color-fg)] group-hover:text-white transition-colors line-clamp-3">
            {item.title}
          </p>
          {item.excerpt ? (
            <p className="text-[12px] leading-relaxed text-[var(--color-fg-muted)] line-clamp-2">
              {item.excerpt}
            </p>
          ) : null}
        </div>
        <div className="flex items-center justify-between mt-auto pt-2">
          <div className="flex items-center gap-1.5 flex-wrap">
            {item.sourceLabel ? (
              <Badge variant="muted" className="text-[9px] h-5 px-1.5 rounded-sm">
                {item.sourceLabel}
              </Badge>
            ) : null}
            {item.mentions.map((m) => (
              <Badge key={m} variant="accent" className="text-[9px] h-5 px-1.5 rounded-sm bg-[var(--color-accent)]/10 text-[var(--color-accent)] border-none">
                {m.replace("USDT", "")}
              </Badge>
            ))}
          </div>
          <span className="text-[10px] text-[var(--color-fg-subtle)] ml-auto shrink-0">
            {formatDistanceToNowStrict(item.publishedAt * 1000, { addSuffix: true })}
          </span>
        </div>
      </div>
    </a>
  );
}

function FilterChip({
  label,
  count,
  active,
  onClick,
  dim,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  dim?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 h-7 text-[11px] font-medium transition-colors",
        active
          ? "bg-[var(--color-accent-soft)] border-[var(--color-accent)]/40 text-[var(--color-fg)]"
          : dim
            ? "border-[var(--color-border)] bg-white/[0.01] text-[var(--color-fg-subtle)] hover:bg-white/[0.03] hover:text-[var(--color-fg-muted)]"
            : "border-[var(--color-border)] bg-white/[0.02] text-[var(--color-fg-muted)] hover:bg-white/[0.05] hover:text-[var(--color-fg)]",
      )}
    >
      <span>{label}</span>
      <span
        className={cn(
          "text-[10px] tabular-nums",
          active ? "text-[var(--color-accent)]" : "text-[var(--color-fg-subtle)]",
        )}
      >
        {count}
      </span>
    </button>
  );
}

function SourceTab({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "px-3 h-7 text-[11px] font-medium rounded-md border transition-colors",
        active
          ? "bg-[var(--color-accent-soft)] border-[var(--color-accent)]/40 text-[var(--color-fg)]"
          : "border-[var(--color-border)] bg-white/[0.01] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]",
      )}
    >
      {label}
    </button>
  );
}

function SkeletonRows() {
  return (
    <>
      {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
        <div
          key={i}
          className="flex flex-col rounded-2xl border border-[var(--color-border)] bg-white/[0.01] overflow-hidden h-[240px]"
        >
          <div className="w-full h-32 bg-white/[0.03] animate-pulse shrink-0 border-b border-[var(--color-border)]" />
          <div className="p-4 space-y-3 flex-1">
            <div className="h-4 w-5/6 rounded bg-white/[0.05] animate-pulse" />
            <div className="h-3 w-4/6 rounded bg-white/[0.05] animate-pulse" />
            <div className="h-3 w-1/3 rounded bg-white/[0.05] animate-pulse mt-auto" />
          </div>
        </div>
      ))}
    </>
  );
}

function ErrorState({ error }: { error: string }) {
  return (
    <div className="rounded-md border border-[var(--color-warn)]/30 bg-[var(--color-warn-soft)] p-3 space-y-1">
      <div className="flex items-center gap-2 text-[var(--color-warn)] text-xs font-semibold">
        <Sparkles className="size-3.5" /> News feed unavailable
      </div>
      <p className="text-[11px] leading-5 text-[var(--color-fg-muted)] break-words">
        {error}
      </p>
    </div>
  );
}

function formatScore(n: number): string {
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`;
  return `${n}`;
}
