/**
 * Public types for the news-validation layer.
 *
 * Kept dep-free on purpose: imported by server modules (orchestrator,
 * server actions) AND the client store / UI. Anything that pulls in
 * server-only deps belongs in `validator.ts`, `coin-feed.ts`, or the
 * AI sub-folder.
 */

/**
 * Six-tier sentiment + risk taxonomy applied to a single headline or to
 * an aggregate of headlines.
 *
 *   VERY_BULLISH    – strong positive catalyst (ETF approval, record inflows)
 *   BULLISH         – mildly positive (partnership, upgrade, adoption)
 *   NEUTRAL         – no directional signal
 *   RISK_WARNING    – elevated risk (lawsuit, probe, outage, delisting)
 *   BEARISH         – mildly negative (sell-off, downgrade, fud)
 *   CRITICAL_RISK   – immediate threat (hack, exploit, exchange halt,
 *                     SEC emergency action, depeg, insolvency, cascade
 *                     liquidations)
 */
export type NewsClass =
  | "VERY_BULLISH"
  | "BULLISH"
  | "NEUTRAL"
  | "RISK_WARNING"
  | "BEARISH"
  | "CRITICAL_RISK";

/**
 * What the news layer recommends the execution engine do with the
 * candidate trade. Engine is free to apply this fully, partially, or
 * ignore — the validator is advisory, not authoritative.
 */
export type NewsValidationAction =
  | "ALLOW"                  // No adjustment — proceed normally.
  | "BOOST"                  // Slight size boost / wider TP latitude.
  | "SHRINK"                 // Reduce position size.
  | "TIGHTEN_SL"             // Bring stop-loss closer to entry.
  | "REQUIRE_CONFIRMATION"   // Higher confidence threshold; engine may wait.
  | "REJECT";                // Block this trade entirely.

/**
 * Whether the validator could form an opinion at all.
 *
 *   ok           – fresh coin-scoped news classified successfully.
 *   no_coverage  – feeds healthy but no items mention this coin in window.
 *   unavailable  – fetch / classifier error; engine should fall back to
 *                  technical-only execution (NEVER block on this status).
 */
export type NewsValidationStatus = "ok" | "no_coverage" | "unavailable";

export type NewsClassConfidence = "low" | "medium" | "high";

export interface ClassifiedNewsItem {
  id: string;
  title: string;
  excerpt: string;
  url: string;
  /** "cryptocompare" | "reddit" | <future>. Kept loose so we can add feeds. */
  source: string;
  /** Unix seconds — same convention as the feed aggregator. */
  publishedAt: number;
  /** Age at the moment validation ran. */
  ageMinutes: number;
  class: NewsClass;
  confidence: NewsClassConfidence;
  /** Trigger keywords (rule path) or top reasoning fragment (LLM path). */
  matchedKeywords: string[];
  /** 0..1 freshness weight. <15m → 1.0, 15-60m → ~0.85, 6h → ~0.5, 24h → ~0.2. */
  freshnessWeight: number;
  /**
   * Signed per-item impact contribution to the aggregate score.
   * Positive = bullish for the side, negative = bearish for the side.
   * Magnitude already includes the freshness weight.
   */
  impact: number;
  /** True if the LLM classifier upgraded/confirmed the rule-based class. */
  enriched: boolean;
  reasoning?: string;
}

/**
 * Per-source health snapshot. The validator reports what it saw so the
 * UI can render "Reddit feed unavailable — using CryptoCompare only".
 */
export interface NewsSourceHealth {
  source: string;
  status: "ok" | "stale" | "failed" | "skipped";
  itemCount: number;
  error?: string;
}

/**
 * The full validation result — bundled into the DecisionResponse and stored
 * on the client so the UI can render adjustments and reasoning without an
 * extra round-trip.
 */
export interface NewsValidationResult {
  status: NewsValidationStatus;
  /** Watchlist symbol the validation was run for. */
  symbol: string;
  /** Side of the candidate trade. */
  side: "LONG" | "SHORT" | "NONE";
  /** Aggregate class across the considered items, freshness-weighted. */
  aggregateClass: NewsClass;
  /**
   * Signed adjustment to the technical score / confidence.
   * Balanced policy: clamped to [-30, +15] — bad news bites harder.
   */
  score: number;
  /** Recommended action for the execution engine. */
  action: NewsValidationAction;
  /**
   * Position-sizing multiplier under the balanced policy:
   *   BOOST    → 1.10  (small bump)
   *   ALLOW    → 1.00
   *   SHRINK   → 0.65
   *   TIGHTEN_SL / REQUIRE_CONFIRMATION → 0.85
   *   REJECT   → 0    (engine should also short-circuit before sizing)
   */
  sizeMultiplier: number;
  /**
   * Stop-loss-distance multiplier (1.0 = no change, <1 = tighter stop).
   *   TIGHTEN_SL → 0.70
   *   SHRINK     → 0.85
   *   default    → 1.00
   */
  stopMultiplier: number;
  /** One-line, human-readable justification. UI shows this verbatim. */
  rationale: string;
  /** Top items that drove the aggregate (sorted by absolute impact). Max 5. */
  items: ClassifiedNewsItem[];
  /** Total items considered before truncation. */
  itemsConsidered: number;
  /** Age of the freshest relevant item, or null when status != "ok". */
  freshestItemAgeMinutes: number | null;
  /** Per-source health diagnostics. */
  sourceHealth: NewsSourceHealth[];
  /** Was the LLM classifier consulted at all on this call? */
  llmEnrichmentUsed: boolean;
  /** Unix ms when this result was produced. */
  validatedAt: number;
}

/**
 * Default neutral / "no-op" result. The execution engine reads this when
 * the validator failed, when there's no relevant news, or when news is
 * disabled by env flag — exactly the fail-open contract.
 */
export function unavailableNewsResult(
  symbol: string,
  side: "LONG" | "SHORT" | "NONE",
  reason: string,
): NewsValidationResult {
  return {
    status: "unavailable",
    symbol,
    side,
    aggregateClass: "NEUTRAL",
    score: 0,
    action: "ALLOW",
    sizeMultiplier: 1,
    stopMultiplier: 1,
    rationale: `News validation unavailable — ${reason}; proceeding on technicals.`,
    items: [],
    itemsConsidered: 0,
    freshestItemAgeMinutes: null,
    sourceHealth: [],
    llmEnrichmentUsed: false,
    validatedAt: Date.now(),
  };
}

export function noCoverageNewsResult(
  symbol: string,
  side: "LONG" | "SHORT" | "NONE",
  sourceHealth: NewsSourceHealth[],
): NewsValidationResult {
  return {
    status: "no_coverage",
    symbol,
    side,
    aggregateClass: "NEUTRAL",
    score: 0,
    action: "ALLOW",
    sizeMultiplier: 1,
    stopMultiplier: 1,
    rationale: "No coin-specific news in the last 24h — proceeding on technicals.",
    items: [],
    itemsConsidered: 0,
    freshestItemAgeMinutes: null,
    sourceHealth,
    llmEnrichmentUsed: false,
    validatedAt: Date.now(),
  };
}
