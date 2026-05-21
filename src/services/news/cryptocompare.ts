/**
 * CryptoCompare News — free, no-auth professional crypto headlines.
 *
 * Endpoint: https://min-api.cryptocompare.com/data/v2/news/?lang=EN
 * Returns ~50 latest articles each call. We cache for 5 minutes per
 * `lang` since the feed itself updates every few minutes.
 */

export interface CCNewsItem {
  /** Stable id from CryptoCompare so the UI can dedupe. */
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
  /** -1..1 normalized from upvotes/downvotes. */
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
 * Detailed fetch — returns items plus a diagnostic so the aggregator can
 * surface "CryptoCompare unavailable" in the UI instead of silently
 * pretending the feed is empty.
 */
export async function getCryptoCompareNewsDetailed(): Promise<CCFetchResult> {
  if (cache && cache.expiresAt > Date.now()) return { items: cache.value };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(buildEndpoint(), {
      headers: {
        Accept: "application/json",
        "User-Agent":
          "tradeflow:news-aggregator:1.0 (paper-trading simulator)",
      },
      signal: controller.signal,
      next: { revalidate: 300 },
    });
    if (!res.ok) {
      const err = `HTTP ${res.status}`;
      console.warn(`[news/cryptocompare] ${err}`);
      if (cache) return { items: cache.value, error: err, stale: true };
      return { items: [], error: err };
    }
    const json = (await res.json()) as CCResponse;
    // CryptoCompare sometimes returns Data as {} or "Success" instead of
    // an array — guard with Array.isArray to prevent .map() crash.
    if (!json.Data || !Array.isArray(json.Data)) {
      const err = json.Message ?? `unexpected Data shape: ${typeof json.Data}`;
      console.warn(`[news/cryptocompare] ${err}`);
      if (cache) return { items: cache.value, error: err, stale: true };
      return { items: [], error: err };
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
    console.warn(`[news/cryptocompare] ${msg}`);
    if (cache) return { items: cache.value, error: msg, stale: true };
    return { items: [], error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/** Backwards-compatible shim — drop when no callers reference it. */
export async function getCryptoCompareNews(): Promise<CCNewsItem[]> {
  return (await getCryptoCompareNewsDetailed()).items;
}
