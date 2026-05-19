import type { StrategyOutput } from "../types";

/**
 * Validates a `StrategyOutput` returned by a strategy module. Drops outputs
 * that violate the contract (NaN scores, empty arrays, out-of-range
 * confidence) rather than passing junk to the fusion layer.
 *
 * Returns a `{ ok: true, value }` on pass, or `{ ok: false, reason }` so the
 * pipeline can log which strategy is misbehaving without raising.
 */
export type ValidationResult =
  | { ok: true; value: StrategyOutput }
  | { ok: false; reason: string };

export function validateOutput(out: StrategyOutput): ValidationResult {
  if (!out.strategyId || !out.strategyName) {
    return { ok: false, reason: "missing strategyId or strategyName" };
  }
  if (!isFiniteInRange(out.confidence, 0, 100)) {
    return { ok: false, reason: `confidence ${out.confidence} out of [0, 100]` };
  }
  if (!isFiniteInRange(out.momentumScore, -100, 100)) {
    return { ok: false, reason: `momentumScore ${out.momentumScore} out of [-100, 100]` };
  }
  if (!isFiniteInRange(out.trendScore, -100, 100)) {
    return { ok: false, reason: `trendScore ${out.trendScore} out of [-100, 100]` };
  }
  if (!isFiniteInRange(out.volatilityScore, 0, 100)) {
    return { ok: false, reason: `volatilityScore ${out.volatilityScore} out of [0, 100]` };
  }
  if (!Array.isArray(out.reasoning) || out.reasoning.length === 0) {
    return { ok: false, reason: "reasoning array missing or empty" };
  }
  return { ok: true, value: out };
}

function isFiniteInRange(n: number, lo: number, hi: number): boolean {
  return Number.isFinite(n) && n >= lo && n <= hi;
}
