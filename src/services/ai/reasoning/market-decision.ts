import { getLlmProvider } from "../providers";
import { buildMarketDecisionPrompt } from "../prompts/market-decision";
import {
  MarketDecisionSchema,
  type DecisionInput,
  type MarketDecision,
} from "../schemas";

export interface CachedDecision {
  decision: MarketDecision;
  generatedAt: string;
  provider: string;
  model: string;
  /** Fingerprint key the cache hit on, for observability. */
  key: string;
}

/**
 * In-memory decision cache keyed by a coarse fingerprint of the input.
 *
 * Two competing pressures:
 *   1) Don't spam Groq — the executor may poll every market tick.
 *   2) Don't return a stale decision across a regime flip.
 *
 * We bucket price to 0.05% and include regime/HTF/portfolio shape in the key,
 * so micro-ticks collapse but a real regime change always misses and triggers
 * a fresh decision. TTL caps even an identical-fingerprint hit at 90 seconds
 * so the model gets a second look on slow drift.
 */
const cache = new Map<string, { value: CachedDecision; expiresAt: number }>();
const TTL_MS = 90 * 1000;
const MAX_ENTRIES = 64;

function fingerprint(input: DecisionInput): string {
  // 0.05% price bucket — tight enough that a 1% intraday move triggers a
  // fresh call, loose enough that tick-level chatter collapses.
  const priceBucket = Math.round(input.price * 2000) / 2000;
  const adxBucket = input.indicators.adx14 != null
    ? Math.round(input.indicators.adx14 / 5) * 5
    : "n/a";
  const rsiBucket = input.indicators.rsi14 != null
    ? Math.round(input.indicators.rsi14 / 5) * 5
    : "n/a";
  // Strategy snapshot fingerprint — bucket netDirection to 10-point steps so
  // a regime/alignment flip busts the cache while micro-noise doesn't.
  const snapDir =
    input.strategySnapshot != null
      ? Math.round(input.strategySnapshot.netDirection / 10) * 10
      : "n/a";
  const snapAlign =
    input.strategySnapshot != null
      ? Math.round(input.strategySnapshot.alignmentScore / 10) * 10
      : "n/a";
  // Candlestick intelligence shouldn't cache through a regime flip in pattern
  // bias. Bucket netBias by 20 + dominant category — fine-grained enough
  // that a real pattern shift busts, coarse enough not to thrash.
  const cdlBias =
    input.candlestickIntelligence != null
      ? Math.round(input.candlestickIntelligence.netBias / 20) * 20
      : "n/a";
  const cdlCat = input.candlestickIntelligence?.dominantCategory ?? "n/a";

  return [
    input.symbol,
    input.timeframe,
    input.marketRegime,
    input.htfTrend ?? "n/a",
    priceBucket,
    rsiBucket,
    adxBucket,
    input.portfolio?.hasOpenPositionThisSymbol ? "hasPos" : "noPos",
    input.portfolio?.openPositionsCount ?? "n/a",
    input.sentiment?.fearGreedIndex
      ? Math.round(input.sentiment.fearGreedIndex / 10) * 10
      : "n/a",
    snapDir,
    snapAlign,
    cdlBias,
    cdlCat,
  ].join("|");
}

function readCache(key: string): CachedDecision | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function writeCache(key: string, value: CachedDecision) {
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { value, expiresAt: Date.now() + TTL_MS });
}

/**
 * Resolve (or generate) the LLM's trade decision for this snapshot.
 *
 * Returns null on any provider/parse/validation failure — the caller (the
 * autonomous executor) treats null as "no decision this cycle, do not act"
 * which is the safe default. Errors are logged for dev visibility.
 */
export async function getMarketDecisionFor(
  input: DecisionInput,
): Promise<CachedDecision | null> {
  const key = fingerprint(input);
  const cached = readCache(key);
  if (cached) return cached;

  try {
    const provider = getLlmProvider();
    const messages = buildMarketDecisionPrompt(input);
    const decision = await provider.chatJson(messages, MarketDecisionSchema, {
      temperature: 0.15,
      maxTokens: 900,
      timeoutMs: 25_000,
    });
    const entry: CachedDecision = {
      decision,
      generatedAt: new Date().toISOString(),
      provider: provider.name,
      model: provider.model,
      key,
    };
    writeCache(key, entry);
    return entry;
  } catch (err) {
    console.error("[ai/market-decision] generation failed:", err);
    return null;
  }
}
