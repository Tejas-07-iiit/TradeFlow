import { WATCHLIST_SYMBOLS, type WatchlistSymbol } from "@/lib/market/symbols";

import { getFearGreed, type FearGreed } from "../sentiment/fear-greed";
import { getCryptoCompareNewsDetailed, type CCNewsItem } from "./cryptocompare";
import { getRedditHotDetailed, type RedditPost } from "./reddit";
import { saveNewsToStore, loadNewsFromStore } from "./news-store";

export type NewsSource = "cryptocompare" | "reddit";
export type Mood = "very bearish" | "bearish" | "neutral" | "bullish" | "very bullish";

export interface FeedItem {
  id: string;
  source: NewsSource;
  title: string;
  excerpt: string;
  url: string;
  /** Unix seconds — clients render with date-fns. */
  publishedAt: number;
  /** Watchlist symbols mentioned in the title or excerpt. */
  mentions: WatchlistSymbol[];
  /** Vote/score/upvotes — meaning depends on source. UI just sorts by it. */
  score: number;
  /** CryptoCompare publisher name, or Reddit flair tag. */
  sourceLabel?: string;
  imageUrl?: string | null;
  /** Reddit only. */
  comments?: number;
}

export interface TrendingTicker {
  symbol: WatchlistSymbol;
  mentions: number;
  /** First few titles where the symbol was spotted — for tooltip/hover. */
  recentTitles: string[];
}

export interface MarketPulse {
  fearGreed: FearGreed | null;
  /** Aggregated mood from Reddit flair frequency. */
  redditMood: Mood;
  /** Aggregated mood from CryptoCompare vote scores. */
  newsMood: Mood;
}

export interface SourceStatus {
  /** Human-readable source name for the UI. */
  source: NewsSource;
  /** ok = items returned, stale = served previous cache, failed = empty. */
  status: "ok" | "stale" | "failed";
  /** Number of items returned this fetch. */
  count: number;
  /** Diagnostic from upstream when status != ok. */
  error?: string;
}

export interface NewsFeed {
  items: FeedItem[];
  trending: TrendingTicker[];
  pulse: MarketPulse;
  /** Unix seconds when this feed was assembled. */
  fetchedAt: number;
  /** Per-source health so the UI can show why a source might be empty. */
  sources: SourceStatus[];
}

/**
 * Map watchlist symbols to the tokens we look for in news text. Both the
 * ticker code and the human name; the LLM is good at the former, retail
 * news copy tends to use the latter ("Bitcoin", "Solana").
 *
 * "BNB" stays short — it's already the canonical token.
 */
const SYMBOL_TOKENS: Record<WatchlistSymbol, string[]> = {
  BTCUSDT: ["BTC", "Bitcoin"],
  ETHUSDT: ["ETH", "Ethereum", "Ether"],
  SOLUSDT: ["SOL", "Solana"],
  BNBUSDT: ["BNB", "Binance Coin"],
};

/**
 * Whole-word, case-insensitive symbol detection. Returns the set of
 * watchlist symbols mentioned in `text`.
 *
 * Why word-boundary regex instead of substring: "ETH" would otherwise
 * match "ETHEREUM" twice and "Ethernet" once. Whole-word avoids both.
 */
function detectMentions(text: string): WatchlistSymbol[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  const hits = new Set<WatchlistSymbol>();
  for (const symbol of WATCHLIST_SYMBOLS) {
    const tokens = SYMBOL_TOKENS[symbol];
    for (const token of tokens) {
      // \b for word boundary works on alphanumeric, fine for our tokens.
      const re = new RegExp(`\\b${token.toLowerCase()}\\b`, "i");
      if (re.test(lower)) {
        hits.add(symbol);
        break;
      }
    }
  }
  return [...hits];
}

function ccToFeed(items: CCNewsItem[]): FeedItem[] {
  return items.map((it) => {
    const text = `${it.title} ${it.body}`;
    return {
      id: `cc:${it.id}`,
      source: "cryptocompare",
      title: it.title,
      excerpt: it.body,
      url: it.url,
      publishedAt: it.publishedAt,
      mentions: detectMentions(text),
      // Map normalized vote [-1..1] onto a 0..100 score so it ranks
      // alongside Reddit scores. Mid-zero votes land at 50.
      score: Math.round((it.votes + 1) * 50),
      sourceLabel: it.source,
      imageUrl: it.imageUrl,
    };
  });
}

function redditToFeed(posts: RedditPost[]): FeedItem[] {
  return posts.map((p) => {
    const text = `${p.title} ${p.selftext}`;
    return {
      id: `r:${p.id}`,
      source: "reddit",
      title: p.title,
      excerpt: p.selftext,
      url: p.permalink,
      publishedAt: p.createdAt,
      mentions: detectMentions(text),
      score: p.score,
      sourceLabel: p.flair ?? "r/CryptoCurrency",
      comments: p.numComments,
    };
  });
}

function dominantMood(counts: { bull: number; bear: number; neutral: number }): Mood {
  const total = counts.bull + counts.bear + counts.neutral;
  if (total === 0) return "neutral";
  const bullPct = counts.bull / total;
  const bearPct = counts.bear / total;
  if (bullPct > 0.6) return "very bullish";
  if (bullPct > 0.4 && bullPct > bearPct + 0.1) return "bullish";
  if (bearPct > 0.6) return "very bearish";
  if (bearPct > 0.4 && bearPct > bullPct + 0.1) return "bearish";
  return "neutral";
}

function redditMoodFrom(posts: RedditPost[]): Mood {
  // Reddit's r/CryptoCurrency posts are flair-tagged — BULLISH / BEARISH /
  // NEUTRAL / DISCUSSION / ANALYSIS / etc. We count the explicit ones and
  // let dominance decide.
  const counts = { bull: 0, bear: 0, neutral: 0 };
  for (const p of posts) {
    const flair = (p.flair ?? "").toUpperCase();
    if (flair.includes("BULL")) counts.bull++;
    else if (flair.includes("BEAR")) counts.bear++;
    else counts.neutral++;
  }
  return dominantMood(counts);
}

function newsMoodFrom(items: CCNewsItem[]): Mood {
  // CryptoCompare votes lean bullish overall (crypto press is positive-coded),
  // so we use distribution thresholds rather than raw average.
  const counts = { bull: 0, bear: 0, neutral: 0 };
  for (const it of items) {
    if (it.votes > 0.2) counts.bull++;
    else if (it.votes < -0.2) counts.bear++;
    else counts.neutral++;
  }
  return dominantMood(counts);
}

function buildTrending(items: FeedItem[]): TrendingTicker[] {
  const byTicker = new Map<WatchlistSymbol, { count: number; titles: string[] }>();
  for (const it of items) {
    for (const m of it.mentions) {
      const slot = byTicker.get(m) ?? { count: 0, titles: [] };
      slot.count++;
      if (slot.titles.length < 3) slot.titles.push(it.title);
      byTicker.set(m, slot);
    }
  }
  return [...byTicker.entries()]
    .map(([symbol, v]) => ({
      symbol,
      mentions: v.count,
      recentTitles: v.titles,
    }))
    .sort((a, b) => b.mentions - a.mentions);
}

/**
 * Assemble a feed from every available source in parallel.
 *
 * Every source is independently optional — if one fails or returns empty,
 * the others still surface. We sort by publishedAt desc so the freshest
 * items lead; clients can re-sort by score for "trending" views.
 */
export async function getNewsFeed(): Promise<NewsFeed> {
  try {
    const [ccRes, redditRes, fng] = await Promise.all([
      getCryptoCompareNewsDetailed().catch(
        (err) =>
          ({
            items: [] as CCNewsItem[],
            error: err instanceof Error ? err.message : String(err),
          }) as Awaited<ReturnType<typeof getCryptoCompareNewsDetailed>>,
      ),
      getRedditHotDetailed().catch(
        (err) =>
          ({
            posts: [] as RedditPost[],
            error: err instanceof Error ? err.message : String(err),
          }) as Awaited<ReturnType<typeof getRedditHotDetailed>>,
      ),
      getFearGreed().catch(() => null),
    ]);

    const cc = ccRes.items;
    const reddit = redditRes.posts;

    // Check if both sources failed to fetch anything (either error or returned empty lists)
    const ccFailed = !!ccRes.error || cc.length === 0;
    const redditFailed = !!redditRes.error || reddit.length === 0;

    if (ccFailed && redditFailed) {
      const cached = await loadNewsFromStore();
      if (cached) {
        console.info("[news] Both sources failed/empty, serving from local news store cache.");
        // Mark all sources as stale to reflect they come from the cache
        cached.sources = cached.sources.map((s) => ({
          ...s,
          status: "stale" as const,
        }));
        return cached;
      }
    }

    const items = [...ccToFeed(cc), ...redditToFeed(reddit)].sort(
      (a, b) => b.publishedAt - a.publishedAt,
    );

    const sources: SourceStatus[] = [
      {
        source: "cryptocompare",
        status: ccRes.error ? (ccRes.stale ? "stale" : "failed") : "ok",
        count: cc.length,
        error: ccRes.error,
      },
      {
        source: "reddit",
        status: redditRes.error ? (redditRes.stale ? "stale" : "failed") : "ok",
        count: reddit.length,
        error: redditRes.error,
      },
    ];

    const feed: NewsFeed = {
      items,
      trending: buildTrending(items),
      pulse: {
        fearGreed: fng,
        redditMood: redditMoodFrom(reddit),
        newsMood: newsMoodFrom(cc),
      },
      fetchedAt: Math.floor(Date.now() / 1000),
      sources,
    };

    // Save to local cache store if we got some items successfully
    if (items.length > 0) {
      await saveNewsToStore(feed);
    }

    return feed;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[news/index] Aggregator exception: ${msg}, attempting local cache fallback.`);
    const cached = await loadNewsFromStore();
    if (cached) {
      cached.sources = cached.sources.map((s) => ({
        ...s,
        status: "stale" as const,
      }));
      return cached;
    }
    throw err;
  }
}
