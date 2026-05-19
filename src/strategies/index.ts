import { registerStrategy } from "@/strategy-core/registry";

import { DonchianBreakout } from "./breakout/donchian-breakout";
import { SupportResistanceSweep } from "./market-structure/support-resistance";
import { BollingerReversion } from "./mean-reversion/bollinger-reversion";
import { ShortTermReversal } from "./mean-reversion/short-term-reversal";
import { RangeBreakoutHigh } from "./momentum/range-breakout-high";
import { ResidualMomentum } from "./momentum/residual-momentum";
import { TimeSeriesMomentum } from "./momentum/time-series-momentum";
import { NewsFearGreed } from "./sentiment/news-fear-greed";
import { EmaCrossAdx } from "./trend-following/ema-cross-adx";
import { SmaTrendFilter } from "./trend-following/sma-trend-filter";
import { VolatilityRegime } from "./volatility/volatility-regime";

/**
 * Built-in strategy bootstrap.
 *
 * Each module exports a `StrategyDefinition` and self-registers when this
 * file is imported. Anywhere we need the registry populated (the LLM
 * decision flow, debug routes, future backtests) imports `@/strategies`
 * exactly once and the registry is hot.
 *
 * Adding a new strategy: drop a file under `src/strategies/<category>/`,
 * export its definition, and add it here. No other plumbing required.
 */

const BUILT_IN = [
  TimeSeriesMomentum,
  RangeBreakoutHigh,
  ResidualMomentum,
  ShortTermReversal,
  BollingerReversion,
  SmaTrendFilter,
  EmaCrossAdx,
  DonchianBreakout,
  VolatilityRegime,
  NewsFearGreed,
  SupportResistanceSweep,
];

let bootstrapped = false;
export function bootstrapStrategies(): void {
  if (bootstrapped) return;
  for (const def of BUILT_IN) registerStrategy(def);
  bootstrapped = true;
}

bootstrapStrategies();
