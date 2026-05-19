import type {
  MarketRegime,
  RankedStrategyOutput,
  StrategyCategory,
  StrategyMetadata,
  StrategyOutput,
  StrategySnapshot,
} from "../types";

/**
 * Fusion engine.
 *
 * Inputs: ranked per-strategy outputs (+ regime + Quantpedia principle
 * library matches). Output: a single `StrategySnapshot` that the LLM
 * coordinator consumes.
 *
 * Direction is a weighted vote: each non-HOLD output contributes its
 * `weightedScore` with sign equal to its signal. `netDirection` is the
 * normalised sum on a -100…+100 scale. `alignmentScore` is the share of
 * actionable strategies that agree with the net direction.
 */
export function fuseStrategies(args: {
  symbol: string;
  timeframe: string;
  regime: MarketRegime;
  price: number;
  indicators: import("../types").IndicatorContext;
  ranked: RankedStrategyOutput[];
  skipped: { strategyId: string; reason: string }[];
  relatedPrinciples?: StrategyMetadata[];
}): StrategySnapshot {
  const { ranked, regime } = args;

  const actionable = ranked.filter((r) => r.output.signal !== "HOLD");
  const totalWeight = actionable.reduce((sum, r) => sum + r.weightedScore, 0);
  let directionalSum = 0;
  for (const r of actionable) {
    const sign = r.output.signal === "BUY" ? 1 : -1;
    directionalSum += sign * r.weightedScore;
  }
  const netDirection =
    totalWeight === 0 ? 0 : Math.round((directionalSum / totalWeight) * 100);

  const dominantSign = Math.sign(netDirection);
  const aligned: StrategyOutput[] = [];
  const conflicting: StrategyOutput[] = [];
  const neutral: StrategyOutput[] = [];

  for (const r of ranked) {
    if (r.output.signal === "HOLD") {
      neutral.push(r.output);
      continue;
    }
    const sign = r.output.signal === "BUY" ? 1 : -1;
    if (dominantSign === 0 || sign === dominantSign) aligned.push(r.output);
    else conflicting.push(r.output);
  }

  const alignmentScore =
    actionable.length === 0
      ? 0
      : Math.round((aligned.length / actionable.length) * 100);

  const aggregateMomentumScore = mean(ranked.map((r) => r.output.momentumScore));
  const aggregateTrendScore = mean(ranked.map((r) => r.output.trendScore));
  const aggregateVolatilityScore = mean(ranked.map((r) => r.output.volatilityScore));

  return {
    symbol: args.symbol,
    timeframe: args.timeframe,
    regime,
    indicators: args.indicators,
    price: args.price,
    ranked,
    netDirection,
    alignmentScore,
    aligned,
    conflicting,
    neutral,
    topStrategies: ranked.slice(0, 5),
    aggregateMomentumScore: roundN(aggregateMomentumScore),
    aggregateTrendScore: roundN(aggregateTrendScore),
    aggregateVolatilityScore: roundN(aggregateVolatilityScore),
    skipped: args.skipped,
    relatedPrinciples: args.relatedPrinciples ?? [],
  };
}

/**
 * Pick the category that contributed the most aligned weighted score —
 * surfaces what kind of trade the suite as a whole is voting for, so the
 * Quantpedia matcher can pull related principles.
 */
export function dominantCategory(snapshot: StrategySnapshot): StrategyCategory | null {
  const buckets = new Map<StrategyCategory, number>();
  for (const r of snapshot.ranked) {
    if (r.output.signal === "HOLD") continue;
    const cur = buckets.get(r.output.category) ?? 0;
    buckets.set(r.output.category, cur + r.weightedScore);
  }
  let best: StrategyCategory | null = null;
  let bestScore = -Infinity;
  for (const [cat, score] of buckets) {
    if (score > bestScore) {
      bestScore = score;
      best = cat;
    }
  }
  return best;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function roundN(v: number): number {
  return Math.round(v * 10) / 10;
}
