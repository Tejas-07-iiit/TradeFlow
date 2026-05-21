/**
 * News validation orchestrator — institutional-grade risk layer.
 *
 * Pipeline:
 *   1. Fetch coin-scoped feed (cached 60s) — see `coin-feed.ts`.
 *   2. Drop items older than 24h or with empty mentions.
 *   3. Rule-classify every item.
 *   4. (Hybrid mode) Send the top-N rule-impactful items to the LLM for
 *      a confirming verdict. Rule result is the fallback if the LLM
 *      can't reach quorum on a given id.
 *   5. Apply freshness decay to each item's impact.
 *   6. Sign-flip impact when the candidate side is SHORT (bullish news
 *      hurts a short, bearish news helps it).
 *   7. Aggregate to a single score and recommend an action.
 *
 * Failure mode: any unhandled error returns `unavailableNewsResult` so
 * the executor falls back to technical-only execution. The validator
 * NEVER throws to the caller.
 *
 * Concurrency: dedup'd via an in-flight promise map keyed by
 * `${symbol}:${side}` — multiple concurrent submitters for the same
 * candidate share one validation pass.
 */

import type { WatchlistSymbol } from "@/lib/market/symbols";

import { submitNewsJob } from "../ai/orchestrator";
import {
  classifyHeadline,
  NEWS_CLASS_RAW_IMPACT,
  NEWS_CONFIDENCE_MULTIPLIER,
} from "./classifier";
import { coinDisplayName, getCoinNewsFeed } from "./coin-feed";
import type { FeedItem } from "./index";
import { loadNewsFromStore } from "./news-store";
import {
  noCoverageNewsResult,
  unavailableNewsResult,
  type ClassifiedNewsItem,
  type NewsClass,
  type NewsClassConfidence,
  type NewsValidationAction,
  type NewsValidationResult,
} from "./validator-types";

const ENRICH_TOP_N = 5;
const MAX_RETURNED_ITEMS = 5;

const inFlight = new Map<string, Promise<NewsValidationResult>>();

export interface ValidateNewsOptions {
  /** If true, skip the LLM enrichment pass entirely (rules-only). */
  rulesOnly?: boolean;
}

export async function validateNewsForTrade(
  symbol: WatchlistSymbol,
  side: "LONG" | "SHORT" | "NONE",
  options: ValidateNewsOptions = {},
): Promise<NewsValidationResult> {
  const key = `${symbol}:${side}:${options.rulesOnly ? "rules" : "hybrid"}`;
  const existing = inFlight.get(key);
  if (existing) return existing;

  const promise = runValidation(symbol, side, options).finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return promise;
}

async function runValidation(
  symbol: WatchlistSymbol,
  side: "LONG" | "SHORT" | "NONE",
  options: ValidateNewsOptions,
): Promise<NewsValidationResult> {
  try {
    let isFromCache = false;
    let feed = await getCoinNewsFeed(symbol);
    if (feed.unavailable) {
      const cachedFeed = await loadNewsFromStore();
      if (cachedFeed) {
        const cutoff = Math.floor(Date.now() / 1000) - 24 * 3600; // 24 hours
        const items = cachedFeed.items
          .filter((it) => it.mentions.includes(symbol))
          .filter((it) => it.publishedAt >= cutoff);
        if (items.length > 0) {
          isFromCache = true;
          feed = {
            symbol,
            items,
            sourceHealth: cachedFeed.sources.map((s) => ({
              source: s.source,
              status: "stale" as const,
              itemCount: items.filter((it) => it.source === s.source).length,
              error: s.error,
            })),
            fetchedAt: cachedFeed.fetchedAt,
            unavailable: false,
          };
        }
      }
    }

    if (feed.unavailable) {
      return unavailableNewsResult(symbol, side, feed.error ?? "feed unavailable");
    }
    if (feed.items.length === 0) {
      return noCoverageNewsResult(symbol, side, feed.sourceHealth);
    }

    const coinName = coinDisplayName(symbol);
    const nowSec = Math.floor(Date.now() / 1000);

    // Rule-classify everything first.
    const ruleClassified = feed.items.map((it) => {
      const cls = classifyFromRules(it, coinName, nowSec);
      if (isFromCache) {
        cls.confidence = "low";
        // Recalculate impact using forced low confidence
        const raw = NEWS_CLASS_RAW_IMPACT[cls.class];
        const confMult = NEWS_CONFIDENCE_MULTIPLIER["low"];
        cls.impact = raw * confMult * cls.freshnessWeight;
      }
      return cls;
    });

    // Hybrid mode: pick the top-N by absolute pre-LLM impact, ask the
    // LLM for verdicts, and merge. Items the LLM didn't return retain
    // their rule classification.
    let llmEnrichmentUsed = false;
    let enriched = ruleClassified;
    if (!options.rulesOnly && !isFromCache && ruleClassified.length > 0) {
      const topForLlm = [...ruleClassified]
        .sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact))
        .slice(0, ENRICH_TOP_N)
        .filter((c) => c.class !== "NEUTRAL" || c.freshnessWeight >= 0.85);

      if (topForLlm.length > 0) {
        const jobResult = await submitNewsJob(
          symbol,
          coinName,
          topForLlm.map((c) => ({
            id: c.id,
            title: c.title,
            excerpt: c.excerpt,
          })),
        );
        const verdicts = jobResult.ok ? jobResult.verdicts : null;
        if (verdicts && verdicts.length > 0) {
          llmEnrichmentUsed = true;
          const byId = new Map(verdicts.map((v) => [v.id, v]));
          enriched = ruleClassified.map((c) => {
            const v = byId.get(c.id);
            if (!v) return c;
            const newsClass = (v.class?.toUpperCase() || "NEUTRAL") as NewsClass;
            const confidence = (String(v.confidence).toLowerCase() || "low") as NewsClassConfidence;
            return mergeWithLlm(c, {
              class: newsClass,
              confidence,
              reasoning: v.reasoning,
            });
          });
        }
      }
    }

    // Apply side flip — bullish news hurts a SHORT.
    const sideSign = side === "SHORT" ? -1 : 1;
    const oriented = enriched.map((c) => ({
      ...c,
      impact: c.impact * sideSign,
    }));

    // Aggregate.
    const aggregate = aggregateImpacts(oriented);
    const aggregateClass = inferAggregateClass(oriented);
    const action = recommendAction(aggregate, aggregateClass, oriented, side);
    const { sizeMultiplier, stopMultiplier } = multipliersForAction(action);

    const topItems = [...oriented]
      .sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact))
      .slice(0, MAX_RETURNED_ITEMS);

    const freshest = oriented
      .map((c) => c.ageMinutes)
      .sort((a, b) => a - b)[0] ?? null;

    return {
      status: "ok",
      symbol,
      side,
      aggregateClass,
      score: clampScore(aggregate),
      action,
      sizeMultiplier,
      stopMultiplier,
      rationale: buildRationale({
        action,
        aggregateClass,
        score: aggregate,
        items: topItems,
        side,
        coinName,
      }),
      items: topItems,
      itemsConsidered: oriented.length,
      freshestItemAgeMinutes: freshest,
      sourceHealth: feed.sourceHealth,
      llmEnrichmentUsed,
      validatedAt: Date.now(),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "validator error";
    console.warn(`[news/validator] ${symbol}/${side}: ${msg}`);
    return unavailableNewsResult(symbol, side, msg);
  }
}

function classifyFromRules(
  it: FeedItem,
  coinName: string,
  nowSec: number,
): ClassifiedNewsItem {
  const ruleResult = classifyHeadline(it.title, it.excerpt, coinName);
  const ageMinutes = Math.max(0, Math.round((nowSec - it.publishedAt) / 60));
  const freshness = freshnessWeight(ageMinutes);
  const raw = NEWS_CLASS_RAW_IMPACT[ruleResult.class];
  const confMult = NEWS_CONFIDENCE_MULTIPLIER[ruleResult.confidence];
  const impact = raw * confMult * freshness;
  return {
    id: it.id,
    title: it.title,
    excerpt: it.excerpt,
    url: it.url,
    source: it.source,
    publishedAt: it.publishedAt,
    ageMinutes,
    class: ruleResult.class,
    confidence: ruleResult.confidence,
    matchedKeywords: ruleResult.matchedKeywords,
    freshnessWeight: freshness,
    impact,
    enriched: false,
  };
}

/**
 * Merge an LLM verdict on top of the rule-based classification.
 *
 * Policy:
 *   - LLM class always overrides rule class (the LLM has seen the
 *     headline context, the rule classifier sees keywords).
 *   - Confidence is the MAX of the two (rule + LLM) — if either is
 *     "high" we treat it as high.
 *   - We retain the rule's matched keywords for UI transparency and
 *     append the LLM's reasoning summary.
 */
function mergeWithLlm(
  rule: ClassifiedNewsItem,
  llm: { class: NewsClass; confidence: NewsClassConfidence; reasoning: string },
): ClassifiedNewsItem {
  const confidence = maxConfidence(rule.confidence, llm.confidence);
  const raw = NEWS_CLASS_RAW_IMPACT[llm.class];
  const confMult = NEWS_CONFIDENCE_MULTIPLIER[confidence];
  const impact = raw * confMult * rule.freshnessWeight;
  return {
    ...rule,
    class: llm.class,
    confidence,
    impact,
    enriched: true,
    reasoning: llm.reasoning,
  };
}

const CONF_RANK: Record<NewsClassConfidence, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

function maxConfidence(
  a: NewsClassConfidence,
  b: NewsClassConfidence,
): NewsClassConfidence {
  return CONF_RANK[a] >= CONF_RANK[b] ? a : b;
}

/**
 * Freshness decay. <15m → 1.0, 15-60m → linear decay to 0.85,
 * 1-6h → linear decay to 0.5, 6-24h → linear decay to 0.2, >24h → 0.
 */
function freshnessWeight(ageMinutes: number): number {
  if (ageMinutes < 15) return 1.0;
  if (ageMinutes < 60) {
    // 15 → 1.0, 60 → 0.85
    return 1.0 - ((ageMinutes - 15) / 45) * 0.15;
  }
  if (ageMinutes < 360) {
    // 60 → 0.85, 360 → 0.5
    return 0.85 - ((ageMinutes - 60) / 300) * 0.35;
  }
  if (ageMinutes < 1440) {
    // 360 → 0.5, 1440 → 0.2
    return 0.5 - ((ageMinutes - 360) / 1080) * 0.3;
  }
  return 0;
}

/**
 * Sum item impacts, but cap each individual item's contribution so a
 * single screaming headline can't blow out the aggregate by itself.
 */
function aggregateImpacts(items: ClassifiedNewsItem[]): number {
  const PER_ITEM_CAP = 18;
  let total = 0;
  for (const it of items) {
    total += clamp(it.impact, -PER_ITEM_CAP, PER_ITEM_CAP);
  }
  return total;
}

/** Snap aggregate impact onto the six-tier scale for UI. */
function inferAggregateClass(items: ClassifiedNewsItem[]): NewsClass {
  // Critical risk if any high-confidence CRITICAL_RISK item is fresh
  // (<1h) — regardless of how much bullish news surrounds it.
  const criticalFresh = items.find(
    (i) =>
      // Original class direction is independent of side flip; check raw class.
      i.class === "CRITICAL_RISK" && i.confidence === "high" && i.ageMinutes < 60,
  );
  if (criticalFresh) return "CRITICAL_RISK";

  // Otherwise fall back to summing raw impacts (pre-side-flip view of the
  // market itself, not the trade side).
  const rawTotal = items.reduce((s, i) => {
    const raw = NEWS_CLASS_RAW_IMPACT[i.class];
    return s + raw * NEWS_CONFIDENCE_MULTIPLIER[i.confidence] * i.freshnessWeight;
  }, 0);

  if (rawTotal <= -25) return "CRITICAL_RISK";
  if (rawTotal <= -10) return "BEARISH";
  if (rawTotal < 0) return "RISK_WARNING";
  if (rawTotal === 0) return "NEUTRAL";
  if (rawTotal < 8) return "BULLISH";
  return "VERY_BULLISH";
}

/**
 * Decision rules — "balanced" policy.
 *
 *   CRITICAL_RISK (fresh, high conf, ≥1 corroborating risk item OR alone
 *     with high confidence)            → REJECT
 *   score <= -20                       → SHRINK + TIGHTEN_SL (combined)
 *   -20 < score <= -10                 → TIGHTEN_SL
 *   -10 < score < -3                   → REQUIRE_CONFIRMATION
 *   |score| <= 3                       → ALLOW
 *   3 < score <= 10                    → ALLOW
 *   score > 10                         → BOOST
 *
 * When SHRINK and TIGHTEN_SL collide we resolve to SHRINK; the size
 * multiplier already implies a tighter risk envelope downstream.
 */
function recommendAction(
  score: number,
  aggregateClass: NewsClass,
  items: ClassifiedNewsItem[],
  side: "LONG" | "SHORT" | "NONE",
): NewsValidationAction {
  if (side === "NONE") return "ALLOW";

  // Hard reject: a fresh, high-confidence critical risk item against the
  // direction of the trade. We measure "against" via post-flip impact — a
  // CRITICAL_RISK item has been side-flipped already, so an impact <= -20
  // means it hurts THIS trade specifically.
  const freshCritical = items.find(
    (i) =>
      i.class === "CRITICAL_RISK" &&
      i.confidence === "high" &&
      i.ageMinutes < 60 &&
      i.impact <= -20,
  );
  if (freshCritical) return "REJECT";

  // Also reject if aggregate is CRITICAL_RISK and the trade is on the
  // wrong side of it (score is significantly negative).
  if (aggregateClass === "CRITICAL_RISK" && score <= -22) return "REJECT";

  if (score <= -20) return "SHRINK";
  if (score <= -10) return "TIGHTEN_SL";
  if (score < -3) return "REQUIRE_CONFIRMATION";
  if (score > 10) return "BOOST";
  return "ALLOW";
}

function multipliersForAction(action: NewsValidationAction): {
  sizeMultiplier: number;
  stopMultiplier: number;
} {
  switch (action) {
    case "REJECT":
      return { sizeMultiplier: 0, stopMultiplier: 1 };
    case "SHRINK":
      return { sizeMultiplier: 0.65, stopMultiplier: 0.85 };
    case "TIGHTEN_SL":
      return { sizeMultiplier: 0.85, stopMultiplier: 0.7 };
    case "REQUIRE_CONFIRMATION":
      return { sizeMultiplier: 0.85, stopMultiplier: 1 };
    case "BOOST":
      return { sizeMultiplier: 1.1, stopMultiplier: 1 };
    case "ALLOW":
    default:
      return { sizeMultiplier: 1, stopMultiplier: 1 };
  }
}

/** Balanced-policy clamp on the signed score. */
function clampScore(value: number): number {
  return clamp(Math.round(value), -30, 15);
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function buildRationale(p: {
  action: NewsValidationAction;
  aggregateClass: NewsClass;
  score: number;
  items: ClassifiedNewsItem[];
  side: "LONG" | "SHORT" | "NONE";
  coinName: string;
}): string {
  const top = p.items[0];
  const headline = top
    ? `"${truncate(top.title, 80)}"`
    : "ambient market news";
  const dir = p.action;
  const cls = p.aggregateClass;
  switch (dir) {
    case "REJECT":
      return `Trade rejected — critical risk for ${p.coinName} (${cls}) · ${headline}`;
    case "SHRINK":
      return `Position size reduced — ${cls.toLowerCase().replace("_", " ")} news against ${p.side} · ${headline}`;
    case "TIGHTEN_SL":
      return `Stop tightened — bearish drift for the ${p.side} side · ${headline}`;
    case "REQUIRE_CONFIRMATION":
      return `Mild headwind (${cls.toLowerCase().replace("_", " ")}); requires stronger confirmation · ${headline}`;
    case "BOOST":
      return `Confidence boosted — ${cls.toLowerCase().replace("_", " ")} catalyst supporting ${p.side} · ${headline}`;
    case "ALLOW":
    default:
      return p.items.length === 0
        ? "No coin-specific catalysts; proceeding on technicals."
        : `Neutral news flow (${cls.toLowerCase().replace("_", " ")}); no adjustment.`;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
