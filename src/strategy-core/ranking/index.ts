import { scoreOutput } from "../scorer";
import type {
  MarketRegime,
  RankedStrategyOutput,
  StrategyOutput,
} from "../types";

/**
 * Rank strategy outputs by weighted score, best-first.
 *
 * Ties are broken by raw confidence so we never see a HOLD with the same
 * weighted score outrank an actionable BUY/SELL.
 */
export function rankOutputs(
  outputs: StrategyOutput[],
  regime: MarketRegime,
): RankedStrategyOutput[] {
  const ranked = outputs.map((o) => scoreOutput(o, regime));
  ranked.sort((a, b) => {
    if (b.weightedScore !== a.weightedScore) {
      return b.weightedScore - a.weightedScore;
    }
    return b.output.confidence - a.output.confidence;
  });
  return ranked;
}
