"use client";

import Link from "next/link";
import {
  Gauge,
  MessageSquare,
  Newspaper,
  TrendingUp,
} from "lucide-react";
import { formatDistanceToNowStrict } from "date-fns";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useNewsStore } from "@/store/news-store";

const FNG_TONE = (value: number): string => {
  if (value <= 24) return "text-[var(--color-bear)]";
  if (value <= 44) return "text-[var(--color-warn)]";
  if (value <= 55) return "text-[var(--color-fg)]";
  return "text-[var(--color-bull)]";
};

/**
 * Compact news widget for the dashboard aside.
 *
 * Three sections, vertically stacked:
 *   1) Market pulse — F&G + Reddit + News mood
 *   2) Trending tickers — top 3 mentioned in the last refresh
 *   3) Top chatter — 4 most-discussed Reddit posts (by score)
 *
 * "View all" footer link routes to /news for the full surface.
 */
export function NewsWidget() {
  const feed = useNewsStore((s) => s.feed);
  const loading = useNewsStore((s) => s.loading);

  return (
    <Card className="flex flex-col">
      <CardHeader className="shrink-0">
        <CardTitle className="flex items-center gap-2">
          <Newspaper className="size-4 text-[var(--color-accent)]" />
          Market Pulse
        </CardTitle>
        <Link
          href="/news"
          className="text-[10px] uppercase tracking-wider text-[var(--color-accent)] hover:underline"
        >
          View all
        </Link>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Pulse strip */}
        <div className="grid grid-cols-3 gap-2">
          <PulseCell
            label="F&G"
            value={feed?.pulse.fearGreed ? `${feed.pulse.fearGreed.value}` : "—"}
            sub={feed?.pulse.fearGreed?.classification ?? (loading ? "…" : "—")}
            valueClass={
              feed?.pulse.fearGreed
                ? FNG_TONE(feed.pulse.fearGreed.value)
                : "text-[var(--color-fg-subtle)]"
            }
            icon={Gauge}
          />
          <PulseCell
            label="Reddit"
            value={feed ? capitalize(feed.pulse.redditMood.split(" ").pop()!) : "—"}
            sub={feed ? feed.pulse.redditMood : loading ? "…" : "—"}
            valueClass={moodColor(feed?.pulse.redditMood)}
            icon={MessageSquare}
          />
          <PulseCell
            label="News"
            value={feed ? capitalize(feed.pulse.newsMood.split(" ").pop()!) : "—"}
            sub={feed ? feed.pulse.newsMood : loading ? "…" : "—"}
            valueClass={moodColor(feed?.pulse.newsMood)}
            icon={Newspaper}
          />
        </div>

        {/* Trending tickers */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">
            <TrendingUp className="size-3 text-[var(--color-accent)]" />
            Trending
          </div>
          {!feed?.trending.length ? (
            <p className="text-[11px] text-[var(--color-fg-subtle)]">
              No watchlist symbols spotted in the latest feed.
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {feed.trending.slice(0, 5).map((t) => (
                <Badge
                  key={t.symbol}
                  variant="muted"
                  className="text-[10px] h-5 px-1.5 gap-1"
                >
                  {t.symbol.replace("USDT", "")}
                  <span className="text-[var(--color-accent)] tabular-nums">
                    ·{t.mentions}
                  </span>
                </Badge>
              ))}
            </div>
          )}
        </div>

        {/* Top chatter */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">
            <MessageSquare className="size-3 text-[var(--color-accent)]" />
            What people are saying
          </div>
          {!feed ? (
            <SkeletonRows />
          ) : (
            <ul className="space-y-1">
              {feed.items
                .filter((i) => i.source === "reddit")
                .sort((a, b) => b.score - a.score)
                .slice(0, 4)
                .map((it) => (
                  <li key={it.id}>
                    <a
                      href={it.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block px-2 py-1.5 rounded-md hover:bg-white/[0.03] transition-colors"
                    >
                      <p className="text-[11.5px] leading-snug text-[var(--color-fg)] line-clamp-2">
                        {it.title}
                      </p>
                      <div className="flex items-center gap-2 mt-0.5 text-[10px] text-[var(--color-fg-subtle)]">
                        <span className="text-[var(--color-bull)] tabular-nums">
                          ▲ {formatScore(it.score)}
                        </span>
                        <span>·</span>
                        <span>{it.comments ?? 0} comments</span>
                        <span>·</span>
                        <span>
                          {formatDistanceToNowStrict(it.publishedAt * 1000, {
                            addSuffix: true,
                          })}
                        </span>
                      </div>
                    </a>
                  </li>
                ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function PulseCell({
  label,
  value,
  sub,
  valueClass,
  icon: Icon,
}: {
  label: string;
  value: string;
  sub: string;
  valueClass?: string;
  icon: React.ElementType;
}) {
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-white/[0.02] p-2">
      <div className="flex items-center gap-1 text-[9px] uppercase tracking-wider text-[var(--color-fg-subtle)]">
        <Icon className="size-2.5" />
        {label}
      </div>
      <div className={cn("mt-0.5 text-base font-semibold leading-none tabular-nums", valueClass)}>
        {value}
      </div>
      <div className="mt-0.5 text-[9px] text-[var(--color-fg-subtle)] capitalize truncate">
        {sub}
      </div>
    </div>
  );
}

function SkeletonRows() {
  return (
    <ul className="space-y-1">
      {[0, 1, 2].map((i) => (
        <li key={i} className="px-2 py-1.5">
          <div className="h-3 w-5/6 rounded bg-white/[0.06] animate-pulse" />
          <div className="h-2.5 w-1/2 rounded bg-white/[0.04] animate-pulse mt-1.5" />
        </li>
      ))}
    </ul>
  );
}

function capitalize(s: string) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function moodColor(mood?: string): string {
  if (!mood) return "text-[var(--color-fg-subtle)]";
  if (mood.includes("very bullish")) return "text-[var(--color-bull)]";
  if (mood.includes("bullish")) return "text-[var(--color-bull)]";
  if (mood.includes("very bearish")) return "text-[var(--color-bear)]";
  if (mood.includes("bearish")) return "text-[var(--color-bear)]";
  return "text-[var(--color-fg)]";
}

function formatScore(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${n}`;
}
