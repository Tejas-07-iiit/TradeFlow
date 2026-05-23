import type {
  FamilyBreakdownEntry,
  MarketRegime,
  RankedStrategyOutput,
  StrategyCategory,
  StrategyFamily,
  StrategyMetadata,
  StrategyOutput,
  StrategySignal,
  StrategySnapshot,
} from "../types";
import { familyForOutput } from "./families";

/**
 * Fusion engine.
 *
 * Inputs: ranked per-strategy outputs (+ regime + Quantpedia principle
 * library matches). Output: a single `StrategySnapshot` that the LLM
 * coordinator consumes.
 *
 * Two parallel directional reads are produced:
 *
 *   1. Legacy weighted vote — `netDirection`, `alignmentScore`. Each non-HOLD
 *      output contributes its `weightedScore` with sign equal to its signal.
 *      This double-counts correlated strategies (e.g. 10 trend strategies all
 *      firing on the same EMA stack will register as 10 independent votes).
 *
 *   2. Family-aware vote — `familyNetDirection`, `familyAlignmentScore`,
 *      `effectiveN`, `familyBreakdown`. Strategies are clustered by latent
 *      factor (trend / reversion / volatility / structure / sentiment / ml /
 *      arbitrage). Within a family, scores are averaged (1/N) so a cluster
 *      of N correlated strategies behaves as one vote of cluster-mean
 *      conviction. Family contributions are then summed across families.
 *
 * Both reads are emitted so the LLM prompt, prefilter, and priority engines
 * can be migrated to the family-aware numbers at their own pace and we can
 * observe the divergence in audit logs before flipping live thresholds.
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

  // ── Legacy weighted vote ───────────────────────────────────────────────
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

  // ── Family-aware vote ─────────────────────────────────────────────────
  const family = computeFamilyAggregate(actionable);

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
    familyNetDirection: family.familyNetDirection,
    familyAlignmentScore: family.familyAlignmentScore,
    effectiveN: family.effectiveN,
    familyBreakdown: family.familyBreakdown,
  };
}

interface FamilyAggregate {
  familyNetDirection: number;
  familyAlignmentScore: number;
  effectiveN: number;
  familyBreakdown: FamilyBreakdownEntry[];
}

interface FamilyBucket {
  signedWeight: number;
  absWeight: number;
  members: number;
  buys: number;
  sells: number;
}

/**
 * Cluster actionable outputs by family, then:
 *   - per family: directional contribution = mean(signed weight)  (this is
 *     the 1/N within-family de-correlation — N near-duplicate strategies
 *     count as one vote at their mean conviction)
 *   - per family: absolute "loudness" = mean(abs weight)
 *   - across families: sum directional and absolute contributions to derive
 *     a -100..+100 net direction
 *
 * `effectiveN` uses the standard concentration formula (Σw)² / Σw² applied
 * to the per-family *absolute* contributions. Equal-weight across F families
 * yields effectiveN = F; one family dominating drops it toward 1. This is
 * the diagnostic that exposes "high consensus but only one factor speaking".
 */
function computeFamilyAggregate(
  actionable: RankedStrategyOutput[],
): FamilyAggregate {
  if (actionable.length === 0) {
    return {
      familyNetDirection: 0,
      familyAlignmentScore: 0,
      effectiveN: 0,
      familyBreakdown: [],
    };
  }

  const buckets = new Map<StrategyFamily, FamilyBucket>();
  for (const r of actionable) {
    const fam = familyForOutput(r.output);
    const sign = r.output.signal === "BUY" ? 1 : -1;
    const w = r.weightedScore;
    const bucket = buckets.get(fam) ?? {
      signedWeight: 0,
      absWeight: 0,
      members: 0,
      buys: 0,
      sells: 0,
    };
    bucket.signedWeight += sign * w;
    bucket.absWeight += w;
    bucket.members += 1;
    if (sign > 0) bucket.buys += 1;
    else bucket.sells += 1;
    buckets.set(fam, bucket);
  }

  // Family-level contribution = mean across members (1/N within-family).
  type FamilyContribution = {
    family: StrategyFamily;
    signed: number;
    abs: number;
    members: number;
    dominantSignal: StrategySignal;
  };
  const contributions: FamilyContribution[] = [];
  for (const [fam, b] of buckets) {
    const meanSigned = b.signedWeight / b.members;
    const meanAbs = b.absWeight / b.members;
    const dominantSignal: StrategySignal =
      b.buys === b.sells
        ? meanSigned > 0
          ? "BUY"
          : meanSigned < 0
          ? "SELL"
          : "HOLD"
        : b.buys > b.sells
        ? "BUY"
        : "SELL";
    contributions.push({
      family: fam,
      signed: meanSigned,
      abs: meanAbs,
      members: b.members,
      dominantSignal,
    });
  }

  const totalAbs = contributions.reduce((s, c) => s + c.abs, 0);
  const totalSigned = contributions.reduce((s, c) => s + c.signed, 0);

  const familyNetDirection =
    totalAbs === 0 ? 0 : Math.round((totalSigned / totalAbs) * 100);

  const dominantSign = Math.sign(familyNetDirection);
  let alignedAbs = 0;
  for (const c of contributions) {
    const sign = Math.sign(c.signed);
    if (dominantSign === 0 || sign === dominantSign) alignedAbs += c.abs;
  }
  const familyAlignmentScore =
    totalAbs === 0 ? 0 : Math.round((alignedAbs / totalAbs) * 100);

  // Effective N across families: (Σw)² / Σw² on absolute contributions.
  const sumW = contributions.reduce((s, c) => s + c.abs, 0);
  const sumW2 = contributions.reduce((s, c) => s + c.abs * c.abs, 0);
  const effectiveN = sumW2 === 0 ? 0 : roundN((sumW * sumW) / sumW2);

  const familyBreakdown: FamilyBreakdownEntry[] = contributions
    .map((c) => ({
      family: c.family,
      members: c.members,
      netContribution: roundN(totalAbs === 0 ? 0 : (c.signed / totalAbs) * 100),
      weightShare: roundN(totalAbs === 0 ? 0 : (c.abs / totalAbs) * 100),
      dominantSignal: c.dominantSignal,
    }))
    .sort((a, b) => b.weightShare - a.weightShare);

  return {
    familyNetDirection,
    familyAlignmentScore,
    effectiveN,
    familyBreakdown,
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
