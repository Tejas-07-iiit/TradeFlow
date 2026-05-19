/**
 * CryptoPanic news headlines for a given crypto symbol.
 *
 * Gracefully optional — requires CRYPTOPANIC_TOKEN. Without the env var we
 * return null and the caller (sentiment aggregator) drops the field from the
 * LLM input, so the call path still works.
 *
 * https://cryptopanic.com/developers/api/
 */

interface PanicPost {
  title?: string;
  published_at?: string;
  votes?: { positive?: number; negative?: number; important?: number };
}

interface PanicResponse {
  results?: PanicPost[];
}

export interface NewsSnapshot {
  headlines: string[];
  /** Coarse sentiment from positive vs negative vote counts. */
  sentiment: "very bearish" | "bearish" | "neutral" | "bullish" | "very bullish";
}

/**
 * Map a symbol to the CryptoPanic currency code. CryptoPanic uses tickers
 * without the USDT suffix.
 */
function currencyCode(symbol: string): string {
  return symbol.replace(/USDT$|USD$|BUSD$/i, "").toUpperCase();
}

function classifySentiment(votes: {
  pos: number;
  neg: number;
}): NewsSnapshot["sentiment"] {
  const net = votes.pos - votes.neg;
  const total = votes.pos + votes.neg;
  if (total < 3) return "neutral";
  if (net <= -10) return "very bearish";
  if (net <= -3) return "bearish";
  if (net >= 10) return "very bullish";
  if (net >= 3) return "bullish";
  return "neutral";
}

const cache = new Map<string, { value: NewsSnapshot; expiresAt: number }>();
const TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 4_000;

export async function getNewsSnapshot(
  symbol: string,
): Promise<NewsSnapshot | null> {
  const token = process.env.CRYPTOPANIC_TOKEN;
  if (!token) return null;

  const key = currencyCode(symbol);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const url = `https://cryptopanic.com/api/v1/posts/?auth_token=${encodeURIComponent(token)}&currencies=${key}&public=true&kind=news`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const json = (await res.json()) as PanicResponse;
    const rows = (json.results ?? []).slice(0, 5);
    if (rows.length === 0) return null;
    const headlines = rows
      .map((r) => r.title?.trim())
      .filter((t): t is string => !!t && t.length <= 180);
    const totals = rows.reduce(
      (acc, r) => ({
        pos: acc.pos + (r.votes?.positive ?? 0),
        neg: acc.neg + (r.votes?.negative ?? 0),
      }),
      { pos: 0, neg: 0 },
    );
    const snapshot: NewsSnapshot = {
      headlines,
      sentiment: classifySentiment(totals),
    };
    cache.set(key, { value: snapshot, expiresAt: Date.now() + TTL_MS });
    return snapshot;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
