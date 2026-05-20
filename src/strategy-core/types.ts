import type { CandlestickIntelligence } from "@/lib/candlestick/types";
import type { Candle } from "@/types/market";

/**
 * Canonical strategy framework types.
 *
 * Every strategy module — whether momentum, mean-reversion, breakout, or
 * sentiment — produces a `StrategyOutput` of this exact shape. The fusion
 * engine and the LLM coordinator only consume `StrategyOutput[]`, so the
 * strategies themselves can evolve independently as long as they honour
 * this contract.
 */

export type StrategyCategory =
  | "momentum"
  | "trend-following"
  | "mean-reversion"
  | "volatility"
  | "breakout"
  | "arbitrage"
  | "market-structure"
  | "statistical"
  | "sentiment";

export type StrategySignal = "BUY" | "SELL" | "HOLD";

export type StrategyRisk = "Low" | "Medium" | "High";

export type StrategyTimeframe =
  | "intraday"
  | "short-term"
  | "swing"
  | "position"
  | "monthly";

export type MarketRegime =
  | "Trending Up"
  | "Trending Down"
  | "Sideways"
  | "Choppy"
  | "High Volatility"
  | "Low Volatility"
  | "Breakout"
  | "Reversal";

/**
 * Indicator snapshot computed once per pipeline tick and shared with every
 * strategy. Strategies should NOT recompute indicators themselves.
 */
export interface IndicatorContext {
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  rsi14: number | null;
  atr14: number | null;
  adx14: number | null;
  atrPct: number | null;
  bb: { upper: number; middle: number; lower: number } | null;
  macd: { macd: number; signalLine: number; histogram: number } | null;
  /** 12-bar (one-hour-equiv on a 5m chart) percent return. */
  momentum12: number | null;
  /** 52-period high/low — proxy for the classical "52-week high" anomaly. */
  rangeHigh52: number | null;
  rangeLow52: number | null;
  /** Standard deviation of last-20 log returns (annualised-ish). */
  realizedVol: number | null;
}

/**
 * Sentiment / news fusion. All fields optional — strategies must degrade
 * gracefully when the news service is down.
 */
export interface SentimentContext {
  newsSentiment?: "very bearish" | "bearish" | "neutral" | "bullish" | "very bullish";
  socialSentiment?: "very bearish" | "bearish" | "neutral" | "bullish" | "very bullish";
  /** 0 = extreme fear, 100 = extreme greed. */
  fearGreedIndex?: number;
  headlines?: string[];
}

/**
 * The full context each strategy receives. Pure data — strategies should be
 * deterministic functions of this object so they're trivially testable.
 */
export interface StrategyContext {
  symbol: string;
  timeframe: string;
  price: number;
  candles: Candle[];
  /** Higher-timeframe candles if available, indexed by interval label. */
  htfCandles?: Record<string, Candle[]>;
  indicators: IndicatorContext;
  regime: MarketRegime;
  sentiment?: SentimentContext;
  /**
   * Structured TA-Lib candlestick intelligence for the current bar. Built by
   * the evaluator once per tick and shared with every strategy so the
   * Candlestick Intelligence strategy + any pattern-aware strategy reads
   * the same source. Patterns are *context*, never a sole trigger.
   */
  candlestickIntel?: CandlestickIntelligence;
}

/**
 * The output every strategy must return.
 *
 * Note: `confidence` is the strategy's own conviction (0–100) — it has not
 * yet been weighted by regime suitability. The scorer applies regime weight
 * downstream to produce a `weightedScore` consumed by fusion.
 */
export interface StrategyOutput {
  strategyId: string;
  strategyName: string;
  category: StrategyCategory;
  signal: StrategySignal;
  confidence: number;
  timeframe: StrategyTimeframe;
  regimeFit: MarketRegime[];
  riskLevel: StrategyRisk;
  reasoning: string[];
  indicatorsUsed: string[];
  entryConditions: string[];
  exitConditions: string[];
  stopLossLogic: string;
  takeProfitLogic: string;
  /** 0–100; how volatile the strategy expects the trade to be. */
  volatilityScore: number;
  /** -100…+100; positive = bullish momentum reading. */
  momentumScore: number;
  /** -100…+100; positive = aligned with prevailing trend. */
  trendScore: number;
  /** Optional concrete price targets when the strategy can compute them. */
  suggestedEntry?: number;
  suggestedStopLoss?: number;
  suggestedTakeProfit?: number;
}

/**
 * Static descriptor a strategy module exposes alongside its evaluator. Used
 * by the registry to enable/disable, document, and gate strategies.
 */
export interface StrategyDefinition {
  id: string;
  name: string;
  category: StrategyCategory;
  description: string;
  /** Which timeframes the strategy is designed for. */
  timeframes: StrategyTimeframe[];
  /** Which regimes the strategy performs best in. */
  preferredRegimes: MarketRegime[];
  /** Minimum candles needed before the strategy will produce a non-HOLD. */
  minCandles: number;
  /** Pure evaluator — runs the strategy and returns an output. */
  evaluate: (ctx: StrategyContext) => StrategyOutput;
  /** When false, the registry skips this strategy. */
  enabled: boolean;
}

/**
 * Quantpedia (or any external research) metadata, surfaced to the LLM as a
 * principle library. These are NOT live signals — they are descriptors of
 * known anomalies the LLM can reason about when the live modules align with
 * the same principle.
 */
export interface StrategyMetadata {
  id: string;
  name: string;
  category: string;
  classification: string;
  assetClass: string;
  marketType: string;
  description: string;
  coreLogic: string;
  entryConditions: string;
  exitConditions: string;
  indicatorsUsed: string;
  riskManagement: string;
  timeframe: string;
  rebalancingFrequency: string;
  longShortLogic: string;
  marketRegimeSuitability: string;
  volatilityConsiderations: string;
  performance: {
    cagr?: string;
    sharpe?: string;
    maxDrawdown?: string;
    winRate?: string;
  };
  sourceUrl: string;
  notes: string;
  concepts: string;
}

/**
 * Output of the fusion engine — what the LLM coordinator receives.
 */
export interface StrategySnapshot {
  symbol: string;
  timeframe: string;
  regime: MarketRegime;
  /** Live indicator context the strategies consumed. Surfaced so downstream
   * consumers (server actions, UI) don't have to recompute. */
  indicators: IndicatorContext;
  /** Last close used as the pipeline tick price. */
  price: number;
  /** Per-strategy outputs, ranked best-first. */
  ranked: RankedStrategyOutput[];
  /** -100…+100 net direction across all strategies. */
  netDirection: number;
  /** 0–100 strength of agreement (high = strong consensus). */
  alignmentScore: number;
  /** Strategies that voted with the net direction. */
  aligned: StrategyOutput[];
  /** Strategies that voted against the net direction. */
  conflicting: StrategyOutput[];
  /** Strategies that abstained (HOLD). */
  neutral: StrategyOutput[];
  /** Top-5 highest-conviction strategies for prompt context. */
  topStrategies: RankedStrategyOutput[];
  /** Aggregate momentum / trend / volatility readings (mean of scorer output). */
  aggregateMomentumScore: number;
  aggregateTrendScore: number;
  aggregateVolatilityScore: number;
  /** Strategies that didn't produce because of low candle count etc. */
  skipped: { strategyId: string; reason: string }[];
  /** Quantpedia principles that match the live consensus, for the LLM. */
  relatedPrinciples: StrategyMetadata[];
  /** Structured candlestick intelligence used by the LLM and chart overlay. */
  candlestickIntel?: CandlestickIntelligence;
}

export interface RankedStrategyOutput {
  output: StrategyOutput;
  /** Strategy's own confidence times regime suitability weight. */
  weightedScore: number;
  /** 0–1 multiplier from the regime engine. */
  regimeWeight: number;
}
