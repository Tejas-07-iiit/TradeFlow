import { regimeWeightFor } from "../regime/classifier";
import type { MarketRegime, RankedStrategyOutput, StrategyOutput } from "../types";

/**
 * Per-strategy scorer.
 *
 * The strategy itself emits a raw `confidence` (0–100). The scorer mixes
 * that with the category's regime weight to produce a `weightedScore` the
 * ranking and fusion layers consume.
 *
 * Two extra nudges:
 *   - regimeFit bonus: if the active regime is listed in the strategy's
 *     `regimeFit`, multiply by 1.1.
 *   - HOLD penalty: HOLD outputs still get a score (we want them surfaced
 *     in the UI) but capped at 40 so they don't dominate the ranking.
 */
export function scoreOutput(
  output: StrategyOutput,
  regime: MarketRegime,
): RankedStrategyOutput {
  let regimeWeight = regimeWeightFor(output.category, regime);
  if (output.regimeFit.includes(regime)) {
    regimeWeight *= 1.1;
  }
  let weightedScore = output.confidence * regimeWeight;
  if (output.signal === "HOLD") {
    weightedScore = Math.min(weightedScore, 40);
  }
  return { output, weightedScore, regimeWeight };
}
