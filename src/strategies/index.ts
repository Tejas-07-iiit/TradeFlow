import { registerStrategy } from "@/strategy-core/registry";

import { BollingerBreakout } from "./breakout/bollinger-breakout";
import { DonchianBreakout } from "./breakout/donchian-breakout";
import { CandlestickIntelligence } from "./candlestick/pattern-intelligence";
import { RallyBaseDrop } from "./market-structure/rally-base-drop";
import { SupportResistanceSweep } from "./market-structure/support-resistance";
import { BollingerReversion } from "./mean-reversion/bollinger-reversion";
import { ShortTermReversal } from "./mean-reversion/short-term-reversal";
import { DowFactorMfiRsi } from "./momentum/dow-factor-mfi-rsi";
import { LorentzianClassification } from "./momentum/lorentzian-classification";
import { ParabolicRsi } from "./momentum/parabolic-rsi";
import { RangeBreakoutHigh } from "./momentum/range-breakout-high";
import { ResidualMomentum } from "./momentum/residual-momentum";
import { TimeSeriesMomentum } from "./momentum/time-series-momentum";
import { WaveTrendOscillator } from "./momentum/wavetrend-oscillator";
import { HashRibbons } from "./sentiment/hash-ribbons";
import { NewsFearGreed } from "./sentiment/news-fear-greed";
import { BestSupertrend } from "./trend-following/best-supertrend";
import { EmaCrossAdx } from "./trend-following/ema-cross-adx";
import { GoldenCross } from "./trend-following/golden-cross";
import { HeikenAshiSwing } from "./trend-following/heiken-ashi-swing";
import { HyperSupertrend } from "./trend-following/hypersupertrend";
import { IchimokuCloud } from "./trend-following/ichimoku-cloud";
import { MaCrossoverVariable } from "./trend-following/ma-crossover-variable";
import { SmaTrendFilter } from "./trend-following/sma-trend-filter";
import { T3Nexus } from "./trend-following/t3-nexus";
import { TwoEmaScalper } from "./trend-following/two-ema-scalper";
import { SqueezeMomentum } from "./volatility/squeeze-momentum";
import { VolatilityRegime } from "./volatility/volatility-regime";
import { ZeiiermanVolatility } from "./volatility/zeiierman-volatility";

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
  // Original framework strategies (Quantpedia-inspired)
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
  CandlestickIntelligence,
  // TradingView-canon additions (institutional + community classics)
  ParabolicRsi,
  RallyBaseDrop,
  MaCrossoverVariable,
  TwoEmaScalper,
  HyperSupertrend,
  BestSupertrend,
  WaveTrendOscillator,
  LorentzianClassification,
  SqueezeMomentum,
  IchimokuCloud,
  BollingerBreakout,
  DowFactorMfiRsi,
  HeikenAshiSwing,
  ZeiiermanVolatility,
  T3Nexus,
  GoldenCross,
  HashRibbons,
];

let bootstrapped = false;
export function bootstrapStrategies(): void {
  if (bootstrapped) return;
  for (const def of BUILT_IN) registerStrategy(def);
  bootstrapped = true;
}

bootstrapStrategies();
