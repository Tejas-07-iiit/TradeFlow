/**
 * Crypto Fear & Greed Index from alternative.me.
 *
 * Public, unauth API: https://api.alternative.me/fng/
 * Refreshes daily. We cache for 30 minutes (the value rarely moves intraday)
 * so we don't hit the endpoint on every decision call.
 */

interface FngResponse {
  data?: Array<{
    value: string;
    value_classification: string;
    timestamp: string;
  }>;
}

export interface FearGreed {
  /** 0 = extreme fear, 100 = extreme greed. */
  value: number;
  classification: string;
  /** ISO timestamp of the F&G reading itself, not when we fetched it. */
  observedAt: string;
}

let cache: { value: FearGreed; expiresAt: number } | null = null;
const TTL_MS = 30 * 60 * 1000;
const FETCH_TIMEOUT_MS = 4_000;

export async function getFearGreed(): Promise<FearGreed | null> {
  if (cache && cache.expiresAt > Date.now()) return cache.value;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch("https://api.alternative.me/fng/?limit=1", {
      signal: controller.signal,
      // Next.js fetch cache: short-lived so we still see fresh data daily.
      next: { revalidate: 1800 },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as FngResponse;
    const row = json.data?.[0];
    if (!row) return null;
    const value = Number.parseInt(row.value, 10);
    if (!Number.isFinite(value) || value < 0 || value > 100) return null;
    const observedAt = new Date(Number.parseInt(row.timestamp, 10) * 1000)
      .toISOString();
    const reading: FearGreed = {
      value,
      classification: row.value_classification,
      observedAt,
    };
    cache = { value: reading, expiresAt: Date.now() + TTL_MS };
    return reading;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
