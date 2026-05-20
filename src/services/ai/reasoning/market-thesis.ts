import { getLlmProvider } from "../providers";
import { buildMarketThesisPrompt } from "../prompts/market-thesis";
import {
  MarketThesisSchema,
  type MarketThesis,
  type ThesisInput,
} from "../schemas";

export interface CachedThesis {
  thesis: MarketThesis;
  generatedAt: string;
  provider: string;
  model: string;
}

/**
 * In-memory thesis cache keyed by a cheap fingerprint of the input.
 *
 * The fingerprint discards tick-level noise: we bucket the price to whatever
 * granularity the regime tolerates and drop sub-percent indicator changes.
 * This keeps the LLM call rate bounded (target: ≤1 per symbol per few
 * minutes) without making the cache so coarse it returns stale theses across
 * a regime change.
 *
 * Caveat: this is a process-local cache. In a serverless deployment each
 * cold start gets its own. That's acceptable for now — the subscriber's
 * 3-minute refresh interval is the real rate limit, the cache just catches
 * duplicate requests within a single hot instance.
 */
const cache = new Map<string, { value: CachedThesis; expiresAt: number }>();
const TTL_MS = 3 * 60 * 1000;
const MAX_ENTRIES = 64;

function fingerprint(input: ThesisInput): string {
  // Bucket the price to 0.1% so micro-ticks don't blow the cache. Regime,
  // signal, and HTF trend are part of the key — a regime flip should always
  // miss and trigger a fresh thesis.
  const priceBucket = Math.round(input.price * 1000) / 1000;
  return [
    input.symbol,
    input.timeframe,
    input.marketRegime,
    input.ruleSignal,
    input.htfTrend ?? "n/a",
    priceBucket,
  ].join("|");
}

function readCache(key: string): CachedThesis | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function writeCache(key: string, value: CachedThesis) {
  if (cache.size >= MAX_ENTRIES) {
    // Evict the oldest entry. Iteration order on Map is insertion order, so
    // the first key is the oldest. Cheap LRU-ish — good enough for ≤64.
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { value, expiresAt: Date.now() + TTL_MS });
}

/**
 * Generate (or return cached) market thesis for the given input.
 *
 * Returns null on provider/parse/validation failure — the caller is expected
 * to render a graceful empty state rather than crash the page. Errors are
 * logged via console.error so dev can spot misconfigured keys.
 */
export async function getMarketThesisFor(
  input: ThesisInput,
): Promise<CachedThesis | null> {
  const key = fingerprint(input);
  const cached = readCache(key);
  if (cached) return cached;

  try {
    const provider = getLlmProvider({ purpose: "thesis" });
    const messages = buildMarketThesisPrompt(input);
    const thesis = await provider.chatJson(messages, MarketThesisSchema, {
      temperature: 0.2,
      maxTokens: 600,
      timeoutMs: 20_000,
    });
    const cacheEntry: CachedThesis = {
      thesis,
      generatedAt: new Date().toISOString(),
      provider: provider.name,
      model: provider.model,
    };
    writeCache(key, cacheEntry);
    return cacheEntry;
  } catch (err) {
    console.error("[ai/market-thesis] generation failed:", err);
    return null;
  }
}
