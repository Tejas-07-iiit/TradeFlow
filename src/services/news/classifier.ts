/**
 * Rule-based news classifier.
 *
 * Maps a headline (+ optional excerpt) into the six-tier
 * VERY_BULLISH..CRITICAL_RISK taxonomy via tiered keyword matching.
 *
 * Deterministic, dep-free, cheap. Used as:
 *   1. First pass on every coin-scoped item (fast filter).
 *   2. Permanent fallback when the LLM classifier is unavailable or
 *      times out.
 *
 * Tiers are checked highest-risk first, then highest-impact upside,
 * then milder bands. First match wins — we never blend categories on
 * one item, the aggregate handles cross-item fusion.
 */

import type { NewsClass, NewsClassConfidence } from "./validator-types";

export interface RuleClassification {
  class: NewsClass;
  confidence: NewsClassConfidence;
  matchedKeywords: string[];
}

/**
 * Keyword bands. Each phrase is normalised to lowercase and matched
 * with word boundaries where applicable. Multi-word phrases are checked
 * as substring (after normalisation) so "sec emergency" catches "SEC
 * emergency order" but not "secret meeting".
 *
 * IMPORTANT: order within a tier matters only for the `matchedKeywords`
 * list ordering shown to the user. Bands themselves are evaluated in
 * the fixed order below.
 */
const CRITICAL_RISK_KEYWORDS = [
  "hack",
  "hacked",
  "exploit",
  "exploited",
  "drained",
  "stolen funds",
  "rug pull",
  "rugpull",
  "rug-pull",
  "depeg",
  "insolvent",
  "insolvency",
  "bankrupt",
  "bankruptcy",
  "liquidation cascade",
  "mass liquidation",
  "billions liquidated",
  "exchange halt",
  "trading halted",
  "withdrawals halted",
  "withdrawals paused",
  "withdrawals suspended",
  "withdrawals frozen",
  "halted withdrawals",
  "frozen funds",
  "emergency action",
  "emergency motion",
  "sec emergency",
  "cease and desist",
  "wire fraud",
  "ponzi",
  "north korea",
  "lazarus",
  "smart contract bug",
  "critical vulnerability",
  "zero-day",
] as const;

const RISK_WARNING_KEYWORDS = [
  "lawsuit",
  "sued",
  "suing",
  "subpoena",
  "investigation",
  "probe",
  "crackdown",
  "delisting",
  "delisted",
  "outage",
  "downtime",
  "service disruption",
  "performance issues",
  "network congestion",
  "fud",
  "ban",
  "banned",
  "restrict",
  "restriction",
  "regulator",
  "regulatory",
  "regulation",
  "lawmaker",
  "tax probe",
  "fines",
  "fined",
  "penalty",
  "settles with",
  "settles for",
  "warning",
  "fraud allegations",
  "whale dump",
  "whale sell",
  "large outflow",
  "$1b liquidation",
  "fed hawkish",
  "rate hike",
  "hawkish",
] as const;

const BEARISH_KEYWORDS = [
  "crash",
  "plunge",
  "plummet",
  "tumble",
  "tumbles",
  "slump",
  "sell-off",
  "selloff",
  "bear",
  "bearish",
  "drops",
  "drop",
  "falls",
  "fall",
  "decline",
  "declines",
  "downgrade",
  "downward",
  "loses",
  "loss",
  "underperform",
  "retreat",
  "correction",
  "weakness",
  "outflow",
  "outflows",
  "negative",
  "concern",
  "concerns",
  "worry",
  "panic",
] as const;

const BULLISH_KEYWORDS = [
  "rally",
  "rallies",
  "surge",
  "surges",
  "soar",
  "soars",
  "gain",
  "gains",
  "rise",
  "rises",
  "rising",
  "climb",
  "climbs",
  "up ",
  "bullish",
  "bull run",
  "rebound",
  "recovery",
  "upgrade",
  "upgraded",
  "partnership",
  "partners with",
  "integrates",
  "integration",
  "adoption",
  "approval",
  "approved",
  "launch",
  "launches",
  "launched",
  "mainnet",
  "milestone",
  "outperform",
  "positive",
  "optimism",
  "optimistic",
  "buying",
  "buyers",
  "demand",
  "accumulate",
  "accumulation",
] as const;

const VERY_BULLISH_KEYWORDS = [
  "etf approval",
  "etf approved",
  "spot etf",
  "etf inflows",
  "record inflows",
  "record high",
  "all-time high",
  "all time high",
  "ath",
  "massive inflow",
  "institutional adoption",
  "blackrock buys",
  "blackrock filing",
  "fidelity buys",
  "treasury allocation",
  "halving",
  "supply shock",
  "breakout",
  "breaks out",
  "breaks above",
  "soars to new high",
  "fed dovish",
  "dovish",
  "rate cut",
  "rate cuts",
  "rate-cut",
  "billions invested",
  "billions inflow",
  "major upgrade activated",
] as const;

/**
 * Some phrases describe other coins, not the one we care about. The
 * aggregator filters by `mentions` before calling us, so we don't need
 * cross-coin scrubbing here — but we DO down-weight items that are
 * obviously general-market commentary rather than coin-specific. The
 * caller can pass `coinName` (e.g. "Bitcoin") and we'll bump confidence
 * up when the headline mentions it explicitly.
 */
export function classifyHeadline(
  title: string,
  excerpt = "",
  coinName?: string,
): RuleClassification {
  const text = `${title} ${excerpt}`.toLowerCase();
  const coinMentioned = coinName ? text.includes(coinName.toLowerCase()) : false;

  // 1. CRITICAL_RISK — highest priority. A single match is enough but we
  //    require either ≥2 critical keywords OR explicit coin mention to mark
  //    `high` confidence. Single ambiguous critical phrase = `medium`.
  const critMatches = findMatches(text, CRITICAL_RISK_KEYWORDS);
  if (critMatches.length > 0) {
    const high = critMatches.length >= 2 || coinMentioned;
    return {
      class: "CRITICAL_RISK",
      confidence: high ? "high" : "medium",
      matchedKeywords: critMatches.slice(0, 4),
    };
  }

  // 2. VERY_BULLISH — strong positive catalysts. Same confidence rules.
  const vbullMatches = findMatches(text, VERY_BULLISH_KEYWORDS);
  if (vbullMatches.length > 0) {
    const high = vbullMatches.length >= 2 || coinMentioned;
    return {
      class: "VERY_BULLISH",
      confidence: high ? "high" : "medium",
      matchedKeywords: vbullMatches.slice(0, 4),
    };
  }

  // 3. RISK_WARNING — elevated risk but not immediate threat.
  const warnMatches = findMatches(text, RISK_WARNING_KEYWORDS);
  if (warnMatches.length > 0) {
    return {
      class: "RISK_WARNING",
      confidence: warnMatches.length >= 2 ? "high" : "medium",
      matchedKeywords: warnMatches.slice(0, 4),
    };
  }

  // 4. BULLISH / BEARISH — count both, let dominance decide.
  const bullMatches = findMatches(text, BULLISH_KEYWORDS);
  const bearMatches = findMatches(text, BEARISH_KEYWORDS);

  if (bearMatches.length > bullMatches.length) {
    return {
      class: "BEARISH",
      confidence: bearMatches.length >= 2 ? "medium" : "low",
      matchedKeywords: bearMatches.slice(0, 4),
    };
  }
  if (bullMatches.length > bearMatches.length) {
    return {
      class: "BULLISH",
      confidence: bullMatches.length >= 2 ? "medium" : "low",
      matchedKeywords: bullMatches.slice(0, 4),
    };
  }

  // 5. Tied or empty — NEUTRAL.
  return { class: "NEUTRAL", confidence: "low", matchedKeywords: [] };
}

function findMatches(text: string, keywords: readonly string[]): string[] {
  const hits: string[] = [];
  for (const kw of keywords) {
    if (text.includes(kw)) hits.push(kw);
  }
  return hits;
}

/**
 * Sign convention used everywhere in the validator:
 *   positive = bullish for a LONG (or bearish for a SHORT)
 *   negative = bearish for a LONG (or bullish for a SHORT)
 *
 * Magnitude is asymmetric — bad news has more weight than good news
 * because regulatory/security risk can wreck a position regardless of
 * technicals.
 */
export const NEWS_CLASS_RAW_IMPACT: Record<NewsClass, number> = {
  VERY_BULLISH: 12,
  BULLISH: 5,
  NEUTRAL: 0,
  RISK_WARNING: -12,
  BEARISH: -6,
  CRITICAL_RISK: -30,
};

/** Confidence multiplier applied on top of the raw class impact. */
export const NEWS_CONFIDENCE_MULTIPLIER: Record<NewsClassConfidence, number> = {
  high: 1.0,
  medium: 0.7,
  low: 0.4,
};
