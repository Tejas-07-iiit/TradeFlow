import "server-only";

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { StrategyMetadata } from "../types";

/**
 * Loads the 82 Quantpedia strategies into the principle library.
 *
 * The JSON files live under `docs/quantpedia-strategies/categorized/<bucket>`.
 * They aren't live trading modules — they're a reference catalogue the LLM
 * can quote when its live strategy outputs align with a documented anomaly
 * ("the consensus matches the 52-Week High Effect described in Quantpedia").
 *
 * Cached after first load. Server-only — the raw JSON includes long-form
 * notes that are wasted bandwidth to ship to the client.
 */

const STRATEGIES_DIR = path.join(
  process.cwd(),
  "docs",
  "quantpedia-strategies",
  "categorized",
);

let cache: StrategyMetadata[] | null = null;

interface RawStrategy {
  "Strategy Name": string;
  Category?: string;
  "Asset Class"?: string;
  "Market Type"?: string;
  "Strategy Description"?: string;
  "Core Logic"?: string;
  "Entry Conditions"?: string;
  "Exit Conditions"?: string;
  "Indicators Used"?: string;
  "Risk Management Rules"?: string;
  Timeframe?: string;
  "Rebalancing Frequency"?: string;
  "Long/Short Logic"?: string;
  "Market Regime Suitability"?: string;
  "Volatility Considerations"?: string;
  "Momentum/Mean Reversion Classification"?: string;
  "Performance Metrics"?: {
    CAGR?: string;
    "Sharpe Ratio"?: string;
    "Max Drawdown"?: string;
  };
  "Win Rate"?: string;
  "Source URL"?: string;
  "Full Notes"?: string;
  "Mathematical/Statistical Concepts"?: string;
}

function toId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalize(raw: RawStrategy): StrategyMetadata {
  return {
    id: toId(raw["Strategy Name"]),
    name: raw["Strategy Name"],
    category: raw.Category ?? "Other",
    classification: raw["Momentum/Mean Reversion Classification"] ?? "Unclassified",
    assetClass: raw["Asset Class"] ?? "Unknown",
    marketType: raw["Market Type"] ?? "Unknown",
    description: raw["Strategy Description"] ?? "",
    coreLogic: raw["Core Logic"] ?? "",
    entryConditions: raw["Entry Conditions"] ?? "",
    exitConditions: raw["Exit Conditions"] ?? "",
    indicatorsUsed: raw["Indicators Used"] ?? "",
    riskManagement: raw["Risk Management Rules"] ?? "",
    timeframe: raw.Timeframe ?? "Unknown",
    rebalancingFrequency: raw["Rebalancing Frequency"] ?? "Unknown",
    longShortLogic: raw["Long/Short Logic"] ?? "Unknown",
    marketRegimeSuitability: raw["Market Regime Suitability"] ?? "",
    volatilityConsiderations: raw["Volatility Considerations"] ?? "",
    performance: {
      cagr: raw["Performance Metrics"]?.CAGR,
      sharpe: raw["Performance Metrics"]?.["Sharpe Ratio"],
      maxDrawdown: raw["Performance Metrics"]?.["Max Drawdown"],
      winRate: raw["Win Rate"],
    },
    sourceUrl: raw["Source URL"] ?? "",
    notes: raw["Full Notes"] ?? "",
    concepts: raw["Mathematical/Statistical Concepts"] ?? "",
  };
}

export async function loadQuantpediaStrategies(): Promise<StrategyMetadata[]> {
  if (cache) return cache;
  const out: StrategyMetadata[] = [];

  const buckets = await readdir(STRATEGIES_DIR);
  for (const bucket of buckets) {
    const dir = path.join(STRATEGIES_DIR, bucket);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const text = await readFile(path.join(dir, file), "utf-8");
        const parsed = JSON.parse(text) as RawStrategy;
        out.push(normalize(parsed));
      } catch (err) {
        console.error(`[quantpedia-loader] failed to read ${file}:`, err);
      }
    }
  }

  cache = out;
  return out;
}

/**
 * Match the live strategy consensus against the Quantpedia library. Returns
 * up to 5 principles whose classification overlaps the dominant category /
 * direction in the consensus.
 *
 * This is intentionally crude — the LLM does the nuanced matching, this
 * function just pre-filters so the prompt stays compact.
 */
export async function relatedPrinciplesFor(args: {
  dominantCategory: string;
  netDirection: number;
}): Promise<StrategyMetadata[]> {
  const all = await loadQuantpediaStrategies();
  const dirHint = args.netDirection > 0 ? "momentum" : "reversal";
  const haystack = `${args.dominantCategory} ${dirHint}`.toLowerCase();
  const scored = all.map((s) => {
    const hay = `${s.category} ${s.classification} ${s.concepts}`.toLowerCase();
    let score = 0;
    for (const tok of haystack.split(/\s+/)) {
      if (tok && hay.includes(tok)) score += 1;
    }
    if (s.performance.sharpe) {
      const sharpe = Number.parseFloat(s.performance.sharpe);
      if (Number.isFinite(sharpe)) score += sharpe * 0.5;
    }
    return { meta: s, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 5).map((s) => s.meta);
}
