import type { ScoredDetection } from "./types";

/**
 * In-memory pattern-detection cache.
 *
 * Key shape: `${symbol}:${timeframe}:${lastCandleTime}`. We bind the cache
 * key to the *closed-bar* timestamp so a detection is emitted ONCE per bar
 * regardless of how many ticks fire while that bar is forming. The engine
 * passes only the last *completed* candle index — never the live partial bar —
 * which means a single key surfaces all 61 detector outputs for that bar in
 * one pass.
 *
 * Eviction: bounded by `MAX_ENTRIES`; oldest insertion wins. The detection
 * map is small per key (≤ 61 entries), so the bound is in keys not bytes.
 */
const cache = new Map<string, { detections: ScoredDetection[]; expiresAt: number }>();
const TTL_MS = 30 * 60 * 1000; // half an hour — survives a tab refresh, expires before stale.
const MAX_ENTRIES = 256;

function makeKey(symbol: string, timeframe: string, barTime: number) {
  return `${symbol}:${timeframe}:${barTime}`;
}

export function readDetections(
  symbol: string,
  timeframe: string,
  barTime: number,
): ScoredDetection[] | null {
  const key = makeKey(symbol, timeframe, barTime);
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.detections;
}

export function writeDetections(
  symbol: string,
  timeframe: string,
  barTime: number,
  detections: ScoredDetection[],
) {
  const key = makeKey(symbol, timeframe, barTime);
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { detections, expiresAt: Date.now() + TTL_MS });
}

/**
 * Eject every cache entry — used by the dev tools and the symbol switch hook
 * so a watchlist change doesn't leak detections from the prior symbol.
 */
export function clearDetectionCache() {
  cache.clear();
}
