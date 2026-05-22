import { checkCooldown, recordSuccess } from "../orchestrator/symbol-cooldown";
import { getLlmProviderChain } from "../providers";
import type { LlmProvider } from "../providers";
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
 * Compact provider label for logs.
 */
function formatProviderLabel(p: LlmProvider): string {
  return p.accountId != null
    ? `${p.name}#${p.accountId}/${p.model}`
    : `${p.name}/${p.model}`;
}

/**
 * Generate (or return cached) market thesis for the given input.
 *
 * Uses the full provider chain so when Account #1 rate-limits, the call
 * falls back to Account #2 instead of silently returning null.
 *
 * Returns null on provider/parse/validation failure — the caller is expected
 * to render a graceful empty state rather than crash the page. Errors are
 * logged via console.error so dev can spot misconfigured keys.
 */
export async function getMarketThesisFor(
  input: ThesisInput,
  preferredAccountId?: number,
  allowFallback = true,
): Promise<CachedThesis | null> {
  const key = fingerprint(input);
  const cached = readCache(key);
  if (cached) return cached;

  if (allowFallback && preferredAccountId === undefined) {
    return null;
  }

  // Symbol-level cooldown — informational only on the thesis path.
  //
  // The cache check above already short-circuits when the same fingerprint
  // exists within the 3-minute TTL. If we're inside the symbol cooldown
  // window but the cache missed (fingerprint changed: price ticked, regime
  // flipped, etc.) we LET THE CALL THROUGH rather than returning null —
  // because returning null here caused the pipeline to interpret the
  // suppression as "Pipeline returned empty thesis" and trigger the local
  // fallback storm seen in production.
  //
  // The recordSuccess call below still updates the cooldown snapshot so
  // the decision path's cross-kind invalidation triggers (vol spike,
  // regime change) work correctly.
  const cooldown = checkCooldown({
    kind: "thesis",
    symbol: input.symbol,
    timeframe: input.timeframe,
    regime: input.marketRegime,
    atrPct: input.indicators?.atrPct ?? null,
  });
  if (cooldown.suppress) {
    console.info(
      `[ai/market-thesis] ${input.symbol} ${cooldown.reason} — cache miss, proceeding with call.`,
    );
  }

  // Thesis sits in the MID tier — strong enough for multi-indicator
  // synthesis but never reaches premium reasoning models. When every mid
  // model is cooled we degrade to LIGHT (handled by getLlmProviderChain),
  // not to premium.
  const chain = getLlmProviderChain({ purpose: "thesis", tier: "mid", preferredAccountId });
  if (chain.length === 0) {
    console.error("[ai/market-thesis] no provider configured for thesis");
    if (!allowFallback) {
      throw new Error("No provider configured for thesis");
    }
    return null;
  }

  const provider = chain[0];
  try {
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
    recordSuccess({
      kind: "thesis",
      symbol: input.symbol,
      timeframe: input.timeframe,
      regime: input.marketRegime,
      atrPct: input.indicators?.atrPct ?? null,
    });
    return cacheEntry;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[ai/market-thesis] ${formatProviderLabel(provider)} failed: ${msg}`,
    );
    if (!allowFallback) {
      throw err;
    }
    return null;
  }
}
