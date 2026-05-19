import "@/strategies";

import { evaluateAllStrategies, type EvaluatorInput } from "./evaluator";
import { dominantCategory, fuseStrategies } from "./fusion";
import { rankOutputs } from "./ranking";
import { relatedPrinciplesFor } from "./registry/quantpedia-loader";
import type { StrategySnapshot } from "./types";

/**
 * One-shot pipeline: evaluate → rank → fuse → enrich with Quantpedia
 * principles. This is the only function callers outside `strategy-core`
 * should need to invoke.
 *
 * Server-side only: the Quantpedia loader reads from disk. If callers ever
 * need a client-side variant, expose a separate `runStrategyPipelineLite`
 * that skips the principles enrichment.
 */
export async function runStrategyPipeline(
  input: EvaluatorInput,
): Promise<StrategySnapshot> {
  const { outputs, skipped, regime, indicators } = evaluateAllStrategies(input);
  const ranked = rankOutputs(outputs, regime);
  const price = input.candles.at(-1)?.close ?? 0;

  const prelim = fuseStrategies({
    symbol: input.symbol,
    timeframe: input.timeframe,
    regime,
    price,
    indicators,
    ranked,
    skipped,
  });

  const cat = dominantCategory(prelim);
  let relatedPrinciples: StrategySnapshot["relatedPrinciples"] = [];
  try {
    relatedPrinciples = await relatedPrinciplesFor({
      dominantCategory: cat ?? "momentum",
      netDirection: prelim.netDirection,
    });
  } catch (err) {
    console.error("[strategy-core] principle enrichment failed:", err);
  }

  return { ...prelim, relatedPrinciples };
}

export type { EvaluatorInput } from "./evaluator";
export * from "./types";
