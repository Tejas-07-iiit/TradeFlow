/**
 * CryptoCompare News — professional crypto headlines.
 *
 * Falls back to public Cointelegraph & CoinDesk RSS feeds if no API key is set
 * or if the CryptoCompare API returns an authentication or rate limit error.
 */

import { 
  extractItems, 
  extractTagContent, 
  extractLinkHref, 
  extractMediaUrl, 
  unescapeHtml, 
  analyzeSentiment 
} from "./rss-parser";

export interface CCNewsItem {
  /** Stable id from CryptoCompare/RSS so the UI can dedupe. */
  id: string;
  title: string;
  /** Excerpt — sometimes empty; we still surface it when available. */
  body: string;
  url: string;
  source: string;
  /** Unix seconds. */
  publishedAt: number;
  imageUrl: string | null;
  /** Comma-separated category labels (e.g. "Bitcoin,Trading"). */
  categories: string;
  /** -1..1 normalized from upvotes/downvotes or sentiment scoring. */
  votes: number;
}

interface CCResponse {
  Data?: Array<{
    id: string;
    title: string;
    body?: string;
    url: string;
    source: string;
    published_on: number;
    imageurl?: string;
    categories?: string;
    upvotes?: string | number;
    downvotes?: string | number;
  }>;
  Message?: string;
}

const BASE = "https://min-api.cryptocompare.com/data/v2/news/?lang=EN";
const TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 7_000;

export interface CCFetchResult {
  items: CCNewsItem[];
  /** Populated when the upstream failed and we returned cached/empty. */
  error?: string;
  /** True when we served from a stale cache because upstream failed. */
  stale?: boolean;
}

let cache: { value: CCNewsItem[]; expiresAt: number } | null = null;

function buildEndpoint(): string {
  const key = process.env.CRYPTOCOMPARE_API_KEY?.trim();
  return key ? `${BASE}&api_key=${encodeURIComponent(key)}` : BASE;
}

/**
 * Aggregates RSS feeds from Cointelegraph and CoinDesk as a public fallback.
 */
async function fetchRssNews(): Promise<CCNewsItem[]> {
  const feeds = [
    { url: "https://cointelegraph.com/rss", source: "Cointelegraph" },
    { url: "https://www.coindesk.com/arc/outboundfeeds/rss", source: "CoinDesk" }
  ];
  
  const results = await Promise.all(
    feeds.map(async (f) => {
      try {
        const res = await fetch(f.url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "application/xml, text/xml, */*"
          },
          next: { revalidate: 300 }
        });
        if (!res.ok) {
          console.warn(`[news/rss] Failed to fetch ${f.source} RSS: HTTP ${res.status}`);
          return [];
        }
        const xml = await res.text();
        const xmlItems = extractItems(xml, "item");
        
        return xmlItems.map((itemXml) => {
          const title = unescapeHtml(extractTagContent(itemXml, "title"));
          const link = extractLinkHref(itemXml).trim();
          const description = unescapeHtml(extractTagContent(itemXml, "description"));
          const pubDateStr = extractTagContent(itemXml, "pubDate");
          const publishedAt = pubDateStr ? Math.floor(Date.parse(pubDateStr) / 1000) : Math.floor(Date.now() / 1000);
          const imageUrl = extractMediaUrl(itemXml) || null;
          const categories = extractTagContent(itemXml, "category");
          
          // Calculate sentiment votes score
          const sentiment = analyzeSentiment(`${title} ${description}`);
          
          // Generate a stable id from url or guid
          let rawId = extractTagContent(itemXml, "guid");
          if (!rawId) {
            rawId = link || title;
          }
          const id = rawId.replace(/[^a-zA-Z0-9]/g, "-");
          
          return {
            id,
            title,
            body: description.slice(0, 400),
            url: link,
            source: f.source,
            publishedAt,
            imageUrl,
            categories,
            votes: sentiment
          };
        });
      } catch (err) {
        console.warn(`[news/rss] Error fetching/parsing ${f.source} RSS:`, err);
        return [];
      }
    })
  );
  
  return results.flat().sort((a, b) => b.publishedAt - a.publishedAt);
}

/**
 * Detailed fetch — returns items plus a diagnostic so the aggregator can
 * surface status in the UI.
 */
export async function getCryptoCompareNewsDetailed(): Promise<CCFetchResult> {
  if (cache && cache.expiresAt > Date.now()) return { items: cache.value };

  const key = process.env.CRYPTOCOMPARE_API_KEY?.trim();
  if (!key) {
    // No API key -> use RSS fallback immediately
    try {
      const items = await fetchRssNews();
      cache = { value: items, expiresAt: Date.now() + TTL_MS };
      return { items };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "RSS fetch error";
      if (cache) return { items: cache.value, error: msg, stale: true };
      return { items: [], error: msg };
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(buildEndpoint(), {
      headers: {
        Accept: "application/json",
        "User-Agent": "tradeflow:news-aggregator:1.0 (paper-trading simulator)",
      },
      signal: controller.signal,
      next: { revalidate: 300 },
    });
    if (!res.ok) {
      const err = `HTTP ${res.status}`;
      console.warn(`[news/cryptocompare] ${err} — falling back to RSS`);
      const items = await fetchRssNews();
      cache = { value: items, expiresAt: Date.now() + TTL_MS };
      return { items };
    }
    const json = (await res.json()) as CCResponse;
    // CryptoCompare sometimes returns Data as {} or "Success" instead of
    // an array — guard with Array.isArray to prevent .map() crash.
    if (!json.Data || !Array.isArray(json.Data)) {
      const err = json.Message ?? `unexpected Data shape: ${typeof json.Data}`;
      console.warn(`[news/cryptocompare] ${err} — falling back to RSS`);
      const items = await fetchRssNews();
      cache = { value: items, expiresAt: Date.now() + TTL_MS };
      return { items };
    }

    const items: CCNewsItem[] = json.Data
      .filter(
        (row): row is NonNullable<typeof row> =>
          row != null && typeof row.id !== "undefined" && typeof row.title === "string",
      )
      .map((row) => {
        const up = Number(row.upvotes ?? 0);
        const down = Number(row.downvotes ?? 0);
        const total = up + down;
        const votes = total > 0 ? (up - down) / total : 0;
        return {
          id: String(row.id),
          title: row.title,
          body: (row.body ?? "").slice(0, 400),
          url: row.url,
          source: row.source,
          publishedAt: row.published_on,
          imageUrl: row.imageurl || null,
          categories: row.categories ?? "",
          votes,
        };
      });

    cache = { value: items, expiresAt: Date.now() + TTL_MS };
    return { items };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "fetch error";
    console.warn(`[news/cryptocompare] ${msg} — falling back to RSS`);
    try {
      const items = await fetchRssNews();
      cache = { value: items, expiresAt: Date.now() + TTL_MS };
      return { items };
    } catch (rssErr) {
      if (cache) return { items: cache.value, error: msg, stale: true };
      return { items: [], error: msg };
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Backwards-compatible shim — drop when no callers reference it. */
export async function getCryptoCompareNews(): Promise<CCNewsItem[]> {
  return (await getCryptoCompareNewsDetailed()).items;
}
