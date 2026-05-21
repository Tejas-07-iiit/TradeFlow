/**
 * Coin-scoped news feed.
 *
 * Reuses the existing aggregator (`getNewsFeed`) — which is already
 * cached per-source with stale-while-error fallback — and filters its
 * items by `mentions`. We add a thin per-coin cache (60s) on top so
 * back-to-back validator calls for the same coin don't re-traverse the
 * aggregator.
 *
 * Why not call the upstreams directly with a `?categories=BTC` filter?
 * Two reasons:
 *   1. Reddit doesn't support per-coin filtering — we'd be re-fetching
 *      a generic listing anyway and filtering client-side.
 *   2. The aggregator already handles upstream failures, RSS fallbacks,
 *      and User-Agent gotchas. Wrapping it keeps one network failure
 *      mode instead of two.
 */

import { SYMBOL_NAMES, type WatchlistSymbol } from "@/lib/market/symbols";

import { getNewsFeed, type FeedItem } from "./index";
import type { NewsSourceHealth } from "./validator-types";

export interface CoinFeedResult {
  symbol: WatchlistSymbol;
  /** Items mentioning the coin, sorted newest first. */
  items: FeedItem[];
  /** Per-source health, propagated from the aggregator. */
  sourceHealth: NewsSourceHealth[];
  /** Unix seconds when the underlying feed was assembled. */
  fetchedAt: number;
  /** True when the feed could not be retrieved at all. */
  unavailable: boolean;
  /** Diagnostic when `unavailable === true`. */
  error?: string;
}

interface CoinCacheEntry {
  value: CoinFeedResult;
  expiresAt: number;
}

const COIN_TTL_MS = 60 * 1000;
const coinCache = new Map<WatchlistSymbol, CoinCacheEntry>();

/**
 * Maximum age (hours) for an item to be considered "current" by the
 * validator. Items older than this are dropped at the feed boundary so
 * the classifier never sees stale events that already played out.
 */
const MAX_ITEM_AGE_HOURS = 24;

export async function getCoinNewsFeed(
  symbol: WatchlistSymbol,
): Promise<CoinFeedResult> {
  const cached = coinCache.get(symbol);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  let result: CoinFeedResult;
  try {
    const feed = await getNewsFeed();
    const cutoff = Math.floor(Date.now() / 1000) - MAX_ITEM_AGE_HOURS * 3600;

    const items = feed.items
      .filter((it) => it.mentions.includes(symbol))
      .filter((it) => it.publishedAt >= cutoff);

    const sourceHealth: NewsSourceHealth[] = feed.sources.map((s) => ({
      source: s.source,
      status: s.status,
      itemCount: items.filter((it) => it.source === s.source).length,
      error: s.error,
    }));

    result = {
      symbol,
      items,
      sourceHealth,
      fetchedAt: feed.fetchedAt,
      unavailable: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "news feed error";
    console.warn(`[news/coin-feed] ${symbol}: aggregator failed: ${msg}`);
    result = {
      symbol,
      items: [],
      sourceHealth: [],
      fetchedAt: Math.floor(Date.now() / 1000),
      unavailable: true,
      error: msg,
    };
  }

  coinCache.set(symbol, { value: result, expiresAt: Date.now() + COIN_TTL_MS });
  return result;
}

/**
 * Human-readable coin name used by the rule classifier to upgrade
 * confidence when a headline explicitly names the asset. Wrapper so
 * callers don't have to import `SYMBOL_NAMES` directly.
 */
export function coinDisplayName(symbol: WatchlistSymbol): string {
  return SYMBOL_NAMES[symbol] ?? symbol.replace("USDT", "");
}
