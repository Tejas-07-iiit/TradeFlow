/**
 * LLM-backed news classifier.
 *
 * Second pass on top of the rule classifier. Only the top-N most-impactful
 * items (sorted by rule confidence × freshness) are sent — keeps token cost
 * bounded and lets the LLM focus on the items that actually move the
 * decision.
 *
 * Failure mode: every call site falls back to rule-only classification.
 * We never throw out of this module; on any error we log and return null.
 *
 * Caching: keyed on a stable hash of (symbol, item ids, item titles) so
 * repeat calls within the cache window don't burn additional tokens.
 *
 * Concurrency: cheap-tier Groq model + low completion budget. We use the
 * `news` purpose so it rides its own GROQ_MODEL_NEWS env if the operator
 * wants to point it at a lighter model than the decision call.
 */

import { z } from "zod";

import { getLlmProviderChain, LlmProviderError } from "./providers";
import type { NewsClass, NewsClassConfidence } from "../news/validator-types";

export interface LlmClassifierItem {
  id: string;
  title: string;
  excerpt: string;
}

export interface LlmClassifierVerdict {
  id: string;
  class: NewsClass;
  confidence: NewsClassConfidence;
  reasoning: string;
}

const NEWS_CLASS_VALUES = [
  "VERY_BULLISH",
  "BULLISH",
  "NEUTRAL",
  "RISK_WARNING",
  "BEARISH",
  "CRITICAL_RISK",
] as const;

const LlmVerdictSchema = z.object({
  verdicts: z
    .array(
      z.object({
        id: z.string().min(1).max(128),
        class: z.enum(NEWS_CLASS_VALUES),
        confidence: z
          .string()
          .transform((v) => v.toLowerCase().trim())
          .pipe(z.enum(["low", "medium", "high"])),
        reasoning: z.string().min(3).max(220),
      }),
    )
    .min(1)
    .max(10),
});

const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_ITEMS_PER_CALL = 5;

interface CacheEntry {
  value: LlmClassifierVerdict[];
  expiresAt: number;
}
const cache = new Map<string, CacheEntry>();

function buildCacheKey(symbol: string, items: LlmClassifierItem[]): string {
  // ids change less often than titles; combine both so a re-publish under
  // the same id with a different title still triggers a fresh call.
  const fp = items
    .map((it) => `${it.id}|${it.title.slice(0, 80)}`)
    .sort()
    .join("¦");
  return `${symbol}::${fp}`;
}

/**
 * Classify a small batch of headlines for a single coin.
 *
 * Returns null on any error (rate limit, schema mismatch, no provider
 * available) — callers MUST treat null as "use rule classifier only".
 */
export async function classifyNewsItemsLLM(
  symbol: string,
  coinName: string,
  items: LlmClassifierItem[],
  preferredAccountId?: number,
  allowFallback = true,
): Promise<LlmClassifierVerdict[] | null> {
  if (items.length === 0) return [];
  const trimmed = items.slice(0, MAX_ITEMS_PER_CALL);
  const cacheKey = buildCacheKey(symbol, trimmed);
  const hit = cache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  if (allowFallback && preferredAccountId === undefined) {
    return null;
  }

  let chain;
  try {
    chain = getLlmProviderChain({
      purpose: "news",
      tier: "light",
      // News is the canonical LIGHT-tier task — never escalates to mid or
      // premium. If every light model is cooled we degrade to the local
      // prefilter, not to a thesis/decision-grade model.
      allowCrossTierFallback: false,
      preferredAccountId,
    });
  } catch (err) {
    if (err instanceof LlmProviderError) {
      console.warn(`[news/llm-classifier] provider unavailable: ${err.message}`);
      if (!allowFallback) {
        throw err;
      }
      return null;
    }
    throw err;
  }
  if (chain.length === 0) {
    console.warn(
      `[news/llm-classifier] no Groq provider configured (set GROQ_MODEL_NEWS or GROQ_MODEL) — using rule-only`,
    );
    if (!allowFallback) {
      throw new Error("No Groq provider configured for news validation");
    }
    return null;
  }

  const system =
    "You are a crypto risk analyst classifying news headlines for an institutional trading desk. " +
    "Use only the six labels: VERY_BULLISH, BULLISH, NEUTRAL, RISK_WARNING, BEARISH, CRITICAL_RISK. " +
    "CRITICAL_RISK means an immediate threat to capital (hack, exploit, exchange halt, depeg, " +
    "regulatory emergency, mass liquidation). RISK_WARNING is elevated but not immediate. " +
    "VERY_BULLISH means a major positive catalyst (ETF approval, record institutional inflows, " +
    "dovish Fed). Reply with JSON: { verdicts: [ { id, class, confidence, reasoning } ] } only.";

  const itemsBlob = trimmed
    .map(
      (it) =>
        `- id=${it.id}\n  title: ${truncate(it.title, 200)}\n  excerpt: ${truncate(it.excerpt, 280)}`,
    )
    .join("\n");

  const user =
    `Coin: ${coinName} (${symbol})\n` +
    `Classify each item below from the perspective of a trader holding ${coinName} ` +
    `right now. Confidence must be exactly one of: "low", "medium", "high" (lowercase). ` +
    `It reflects how certain you are this label is correct, ` +
    `given how concrete and time-relevant the news is.\n\n` +
    `Items:\n${itemsBlob}\n\n` +
    `Return JSON only.`;

  const provider = chain[0];
  try {
    const res = await provider.chatJson(
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      LlmVerdictSchema,
      { maxTokens: 600, temperature: 0.1, timeoutMs: 15_000 },
    );
    // Reorder/filter to the input set so callers can zip by id safely.
    const byId = new Map(res.verdicts.map((v) => [v.id, v]));
    const ordered: LlmClassifierVerdict[] = trimmed
      .map((it) => byId.get(it.id))
      .filter((v): v is LlmClassifierVerdict => v != null);

    if (ordered.length === 0) {
      console.warn(
        `[news/llm-classifier] ${symbol}: LLM returned 0 matching ids — falling back to rules`,
      );
      if (!allowFallback) {
        throw new Error("LLM returned 0 matching ids");
      }
      return null;
    }

    cache.set(cacheKey, { value: ordered, expiresAt: Date.now() + CACHE_TTL_MS });
    return ordered;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[news/llm-classifier] ${symbol}: ${provider.name}#${provider.accountId ?? 1} failed: ${msg}`,
    );
    if (!allowFallback) {
      throw err;
    }
    return null;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
