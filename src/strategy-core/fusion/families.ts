import type {
  StrategyCategory,
  StrategyDefinition,
  StrategyFamily,
  StrategyOutput,
} from "../types";
import { StrategyRegistry } from "../registry";

/**
 * Default category → family mapping.
 *
 * The mapping collapses descriptively-different but factor-equivalent
 * categories. Notably, "momentum", "trend-following", and "breakout" all
 * default to the "trend" family because their signals are functions of the
 * same underlying price-slope latent factor — in any trending regime they
 * fire together and a naive weighted vote double-counts trend information.
 *
 * `statistical` defaults to "reversion" because the current statistical
 * strategies (e.g. Lorentzian, residual momentum) are mean-reverting in
 * effect; individual strategies whose latent factor disagrees with their
 * category should override via `StrategyDefinition.family`.
 */
const DEFAULTS: Record<StrategyCategory, StrategyFamily> = {
  "trend-following": "trend",
  momentum: "trend",
  breakout: "trend",
  "mean-reversion": "reversion",
  statistical: "reversion",
  volatility: "volatility",
  "market-structure": "structure",
  sentiment: "sentiment",
  arbitrage: "arbitrage",
};

export function defaultFamilyForCategory(category: StrategyCategory): StrategyFamily {
  return DEFAULTS[category];
}

/**
 * Resolve a strategy's family given the registry. Falls back to the category
 * default when no per-strategy override is set, and falls back further to
 * "trend" if the registry doesn't know the strategy (shouldn't happen — the
 * snapshot can only contain registered strategies — but we keep the fallback
 * so this function never throws on bad data).
 */
export function familyForOutput(output: StrategyOutput): StrategyFamily {
  const def: StrategyDefinition | undefined = StrategyRegistry.get(output.strategyId);
  if (def?.family) return def.family;
  if (def?.category) return defaultFamilyForCategory(def.category);
  return defaultFamilyForCategory(output.category);
}
