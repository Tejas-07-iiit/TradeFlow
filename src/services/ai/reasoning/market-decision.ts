import { getLlmProviderChain, type LlmTier } from "../providers";
import type { LlmProvider } from "../providers";
import { buildMarketDecisionPrompt } from "../prompts/market-decision";
import {
  MarketDecisionSchema,
  type DecisionInput,
  type MarketDecision,
} from "../schemas";
import { localFallbackDecision } from "./local-fallback";

/**
 * Compact provider label for logs. Renders `groq#2/llama-3.3-70b-versatile`
 * when the provider exposes an `accountId`, otherwise the legacy
 * `groq/llama-3.3-70b-versatile` form. Makes multi-account Groq chains
 * readable without breaking single-account log greps.
 */
function formatProviderLabel(p: LlmProvider): string {
  return p.accountId != null
    ? `${p.name}#${p.accountId}/${p.model}`
    : `${p.name}/${p.model}`;
}

/**
 * Local prefilter result. Built from the strategy snapshot the server
 * already computed, so it costs no LLM tokens. Three outcomes:
 *
 *   skip:true  → snapshot is flat enough that the LLM has nothing to add.
 *                We return a synthetic HOLD decision so the UI / executor
 *                see a stable answer; the autonomous flow treats it as
 *                no-op the same way it would a real HOLD.
 *   tier:cheap → routine evaluation. Route through the cheap-tier Groq
 *                model (`GROQ_MODEL_CHEAP`) first; the configured
 *                purpose model is reserved for elite setups.
 *   tier:premium → snapshot endorses an elite setup. Use the configured
 *                  purpose model (`GROQ_MODEL_DECISION`) for the deeper
 *                  reasoning the trade deserves.
 */
export interface DecisionPrefilter {
  skip: boolean;
  tier?: LlmTier;
  reason: string;
  syntheticDecision?: MarketDecision;
}

const FLAT_ALIGNMENT_MAX = 30;
const FLAT_DIRECTION_MAX = 8;
const ELITE_ALIGNMENT_MIN = 70;

export function prefilterDecision(input: DecisionInput): DecisionPrefilter {
  const snap = input.strategySnapshot;
  const hasOpenPosition = !!input.portfolio?.hasOpenPositionThisSymbol;

  // Skip path. An open position always deserves a fresh look (SL/TP could
  // change), so we only skip when there's no position AND no directional
  // edge to evaluate.
  if (snap && !hasOpenPosition) {
    const flatAlignment = snap.alignmentScore < FLAT_ALIGNMENT_MAX;
    const flatDirection = Math.abs(snap.netDirection) < FLAT_DIRECTION_MAX;
    if (flatAlignment && flatDirection) {
      return {
        skip: true,
        reason: `flat snapshot (align=${snap.alignmentScore.toFixed(0)} netDir=${snap.netDirection.toFixed(0)} regime=${snap.regime})`,
        syntheticDecision: buildSyntheticHold(input),
      };
    }
  }

  // Premium path. Elite alignment earns the deeper reasoning of the 70B.
  // Open-position management stays on the cheap tier because it's about
  // fast SL/TP adjustments, not constructing a new thesis.
  if (snap && snap.alignmentScore >= ELITE_ALIGNMENT_MIN) {
    return {
      skip: false,
      tier: "premium",
      reason: `elite alignment=${snap.alignmentScore.toFixed(0)}`,
    };
  }

  return {
    skip: false,
    tier: "cheap",
    reason: snap
      ? `routine (align=${snap.alignmentScore.toFixed(0)}${hasOpenPosition ? " openPos" : ""})`
      : "no snapshot",
  };
}

function buildSyntheticHold(input: DecisionInput): MarketDecision {
  const price = input.price;
  const regime = input.marketRegime;
  return {
    decision: "HOLD",
    confidence: 30,
    setupQuality: "C",
    riskLevel: "Low",
    executeTrade: false,
    positionSizePercent: 0,
    expectedHoldTimeMinutes: 5,
    entryPrice: price,
    takeProfit: price,
    stopLoss: price,
    reasoning: [
      `Local prefilter: strategy alignment below ${FLAT_ALIGNMENT_MAX} with no directional edge — no LLM coordination needed.`,
    ],
    warnings: [],
    marketSummary: `Skipped LLM coordinator in ${regime} regime — snapshot offered no actionable edge.`,
    alignedStrategies: [],
    conflictingStrategies: [],
    marketConditions: `${regime} regime, alignment below threshold`,
    executionRecommendation: "skip",
  };
}

export interface CachedDecision {
  decision: MarketDecision;
  generatedAt: string;
  provider: string;
  model: string;
  /** Fingerprint key the cache hit on, for observability. */
  key: string;
  /**
   * Where the decision came from.
   *   llm            — normal path through the provider chain.
   *   prefilter      — local rule engine short-circuited a flat snapshot.
   *   local-fallback — every LLM provider failed; deterministic engine
   *                    constructed the decision so trading continues in
   *                    degraded mode.
   */
  source: "llm" | "prefilter" | "local-fallback";
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
/**
 * Fallback decisions get a shorter TTL than LLM decisions so the chain
 * gets re-tried sooner once provider cooldowns elapse. A 20s window is
 * enough to dedupe within a single round-robin tick without locking the
 * symbol into degraded mode while Groq's daily window is recovering.
 */
const FALLBACK_TTL_MS = 20 * 1000;
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
  const ttl =
    value.source === "local-fallback" ? FALLBACK_TTL_MS : TTL_MS;
  cache.set(key, { value, expiresAt: Date.now() + ttl });
}

const lastSuccessfulAnalysisTime: Record<string, number> = {};
const AI_SCAN_COOLDOWN_SEC = process.env.AI_SCAN_COOLDOWN_SEC
  ? parseInt(process.env.AI_SCAN_COOLDOWN_SEC, 10)
  : 120;

/**
 * Resolve (or generate) the LLM's trade decision for this snapshot.
 *
 * Returns null on any provider/parse/validation failure — the caller (the
 * autonomous executor) treats null as "no decision this cycle, do not act"
 * which is the safe default. Errors are logged for dev visibility.
 */
export async function getMarketDecisionFor(
  input: DecisionInput,
  preferredAccountId?: number,
  allowFallback = true,
): Promise<CachedDecision | null> {
  const key = fingerprint(input);
  const symbol = input.symbol;

  // Routine scan cooldown check to limit requests on flat/inactive markets
  const alignment = input.strategySnapshot?.alignmentScore ?? 0;
  const isRoutine = !input.strategySnapshot || alignment < 50;

  if (isRoutine && lastSuccessfulAnalysisTime[symbol]) {
    const timeSinceLast = Date.now() - lastSuccessfulAnalysisTime[symbol];
    if (timeSinceLast < AI_SCAN_COOLDOWN_SEC * 1000) {
      console.info(
        `[ai/market-decision] ${symbol} routine scan cooldown active (${Math.round(
          timeSinceLast / 1000,
        )}s / ${AI_SCAN_COOLDOWN_SEC}s). Skipping / returning cached.`,
      );
      const cachedEntry = readCache(key);
      if (cachedEntry) return cachedEntry;
      return null;
    }
  }

  const cached = readCache(key);
  if (cached) return cached;

  // Local prefilter — gate the LLM with the cheap strategy snapshot first.
  // Flat snapshots short-circuit with a synthetic HOLD so we don't burn
  // tokens on guaranteed no-action cycles. Non-skip outcomes carry a tier
  // that routes the chain cheap-first vs premium-first.
  const prefilter = prefilterDecision(input);
  if (prefilter.skip && prefilter.syntheticDecision) {
    console.info(
      `[ai/market-decision] ${input.symbol} skipped LLM: ${prefilter.reason}`,
    );
    const entry: CachedDecision = {
      decision: prefilter.syntheticDecision,
      generatedAt: new Date().toISOString(),
      provider: "local",
      model: "prefilter",
      key,
      source: "prefilter",
    };
    writeCache(key, entry);
    lastSuccessfulAnalysisTime[symbol] = Date.now();
    return entry;
  }

  const messages = buildMarketDecisionPrompt(input);
  const chain = getLlmProviderChain({
    purpose: "decision",
    tier: prefilter.tier,
    preferredAccountId,
  });
  if (chain.length === 0) {
    console.error("[ai/market-decision] no provider configured for decision");
    if (!allowFallback) {
      throw new Error("No provider configured for decision");
    }
    return null;
  }
  console.info(
    `[ai/market-decision] ${input.symbol} tier=${prefilter.tier ?? "default"} reason=${prefilter.reason} chain=${chain
      .map((p) => `${formatProviderLabel(p)}`)
      .join(" → ")}`,
  );

  let lastErr: unknown = null;
  for (let i = 0; i < chain.length; i++) {
    const provider = chain[i];
    try {
      // 1200 output tokens comfortably fits the schema (reasoning≤4×200
      // + warnings≤3×200 + summaries ≈ ~1.6K chars ≈ ~500 tokens). The
      // previous 2000 cap meant every reservation locked out a 2K slice
      // of TPM budget that almost never materialized — at 2 concurrent
      // calls the local tracker exhausted the 12K cap on llama-3.3-70b
      // while Groq itself reported only ~5K actual usage.
      // Use a NON-reasoning model — reasoning models burn output tokens
      // on hidden chain-of-thought and regularly hit "max completion
      // tokens reached" on this schema.
      const decision = await provider.chatJson(messages, MarketDecisionSchema, {
        temperature: 0.15,
        maxTokens: 1200,
        timeoutMs: 30_000,
      });
      const entry: CachedDecision = {
        decision,
        generatedAt: new Date().toISOString(),
        provider: provider.name,
        model: provider.model,
        key,
        source: "llm",
      };
      writeCache(key, entry);
      lastSuccessfulAnalysisTime[symbol] = Date.now();
      if (i > 0) {
        console.warn(
          `[ai/market-decision] served via fallback #${i}: ${formatProviderLabel(provider)}`,
        );
      }
      return entry;
    } catch (err) {
      lastErr = err;
      const more = i < chain.length - 1;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[ai/market-decision] ${formatProviderLabel(provider)} failed${
          more ? " — trying next fallback" : ""
        }: ${msg}`,
      );
    }
  }

  if (!allowFallback) {
    throw lastErr || new Error("All market decision providers failed");
  }

  // Every LLM provider exhausted. Instead of returning null and freezing
  // the executor for hours, hand control to the local deterministic engine.
  // It reads the same snapshot the LLM would have read and produces a
  // defensively-sized decision. Trading continues in degraded mode.
  console.warn(
    `[ai/market-decision] ${input.symbol} all providers failed — using local fallback engine. lastErr=${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
  const fallbackDecision = localFallbackDecision(input);
  const fallbackEntry: CachedDecision = {
    decision: fallbackDecision,
    generatedAt: new Date().toISOString(),
    provider: "local",
    model: "fallback-engine",
    key,
    source: "local-fallback",
  };
  // Shorter TTL than LLM cache (30s vs 90s) so we retry the LLM chain
  // sooner once cooldowns elapse.
  writeCache(key, fallbackEntry);
  lastSuccessfulAnalysisTime[symbol] = Date.now();
  return fallbackEntry;
}
