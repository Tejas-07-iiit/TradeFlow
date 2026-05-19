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

const ENDPOINT = "https://min-api.cryptocompare.com/data/v2/news/?lang=EN";
const TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5_000;

let cache: { value: CCNewsItem[]; expiresAt: number } | null = null;

export async function getCryptoCompareNews(): Promise<CCNewsItem[]> {
  if (cache && cache.expiresAt > Date.now()) return cache.value;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, {
      signal: controller.signal,
      next: { revalidate: 300 },
    });
    if (!res.ok) return cache?.value ?? [];
    const json = (await res.json()) as CCResponse;
    if (!json.Data) return cache?.value ?? [];

    const items: CCNewsItem[] = json.Data.map((row) => {
      const up = Number(row.upvotes ?? 0);
      const down = Number(row.downvotes ?? 0);
      const total = up + down;
      // Net-vote score in [-1, 1]. Items with no votes land at 0 (neutral),
      // not a missing field, so UI doesn't need a special case.
      const votes = total > 0 ? (up - down) / total : 0;
      return {
        id: row.id,
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
    return items;
  } catch {
    // Soft-fail to the previous cache (if any) — we'd rather show stale news
    // than an error state on a transient network blip.
    return cache?.value ?? [];
  } finally {
    clearTimeout(timer);
  }
}
