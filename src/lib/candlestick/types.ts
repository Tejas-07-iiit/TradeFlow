import type { Candle, Timeframe } from "@/types/market";

/**
 * Candlestick intelligence layer — institutional-grade.
 *
 * The detectors port the TA-Lib CDL* family. Each detector returns a
 * direction-signed strength in the {-100, 0, +100} space (mirroring TA-Lib).
 * The downstream engine converts that raw signal into a structured
 * `ScoredDetection` that the fusion layer + LLM coordinator consume as
 * *context*, never as a sole trigger.
 *
 * Pattern names use the TA-Lib upstream identifier (e.g. `CDLENGULFING`) for
 * traceability against the reference algorithms in `/Ta-lib/`.
 */

export type PatternDirection = "bullish" | "bearish" | "neutral";

/**
 * High-level taxonomy the LLM and UI consume. Reversal patterns are stronger
 * in sideways/range regimes; continuation patterns are stronger in trending
 * regimes; breakout patterns require high ADX; indecision *down-weights*
 * conviction rather than driving a direction.
 */
export type PatternCategory =
  | "Bullish Reversal"
  | "Bearish Reversal"
  | "Continuation"
  | "Indecision"
  | "Momentum"
  | "Exhaustion"
  | "Breakout Confirmation";

/**
 * Static descriptor each detector exports. Lets the engine schedule + classify
 * without re-deriving metadata.
 */
export interface PatternDescriptor {
  /** TA-Lib upstream id, e.g. "CDLENGULFING". */
  id: string;
  /** Human label, e.g. "Bullish Engulfing". */
  name: string;
  /** Direction-neutral category; a pattern that fires both ways still has a
   *  fixed category — direction is read from the detector's signed output. */
  category: PatternCategory;
  /**
   * Minimum number of bars the detector needs (including the current bar).
   * `runEngine` skips a detector if the window is too short.
   */
  lookback: number;
  /**
   * Reliability prior from the literature (0..1). Multiplied into the
   * confidence score so well-known reliable patterns start higher.
   */
  reliability: number;
  /**
   * Pure detector: given a candle window ending at index `endIdx`, returns
   * the TA-Lib-style signed integer (-100, 0, +100). Detectors must be O(1)
   * over the window after a small constant-period averaging pass.
   */
  detect: (candles: Candle[], endIdx: number) => number;
}

/**
 * Raw detection from a single detector before the confidence engine runs.
 */
export interface RawDetection {
  patternId: string;
  patternName: string;
  category: PatternCategory;
  direction: PatternDirection;
  /** Absolute TA-Lib value (always 0 or 100; sign carried by `direction`). */
  rawStrength: 0 | 100;
  /** Index in the candle array where the pattern triggered (the *last* bar). */
  barIndex: number;
  /** Unix-seconds timestamp of the triggering bar. */
  detectionTime: number;
}

/**
 * Per-detection confidence boosts/penalties, surfaced for the LLM + UI so the
 * reasoning is auditable.
 */
export interface ConfidenceBreakdown {
  base: number;
  trendAlignment: number;
  volumeConfirmation: number;
  rsiConfirmation: number;
  emaConfirmation: number;
  vwapConfirmation: number;
  htfAlignment: number;
  adxBoost: number;
  regimePenalty: number;
  volatilityPenalty: number;
  /** Sum, clamped to [0..100]. */
  total: number;
}

/**
 * Structured detection consumed by fusion, the LLM, the chart overlay, and
 * (in Phase 2) the persistence layer.
 */
export interface ScoredDetection {
  patternId: string;
  patternName: string;
  category: PatternCategory;
  direction: PatternDirection;
  timeframe: Timeframe;
  detectionTime: number;
  /** 0..100 — composite confidence after the confirmation pipeline. */
  confidenceScore: number;
  /** 0..100 — pattern's raw strength scaled by literature reliability. */
  patternStrength: number;
  /** Did EMA50 / EMA200 stack agree with the pattern direction? */
  trendAlignment: "with" | "against" | "neutral";
  /** Was the trigger bar's volume above the rolling mean? */
  volumeConfirmation: "confirmed" | "weak" | "absent";
  /** Did a same-direction pattern fire on a higher timeframe within `htfWindowBars`? */
  higherTimeframeAlignment: boolean;
  /** Regime tag at detection time — surfaces context to the LLM. */
  marketRegimeCompatibility: "strong" | "moderate" | "weak";
  /** Auditable confidence math. */
  breakdown: ConfidenceBreakdown;
  /** One-line human reasoning the LLM and UI can show verbatim. */
  reasoning: string;
}

/**
 * Aggregated snapshot the strategy framework / LLM receive for one
 * (symbol, primaryTimeframe) tick. Holds the *top* detections across all
 * scanned timeframes, plus net bullish vs bearish pressure.
 */
export interface CandlestickIntelligence {
  symbol: string;
  primaryTimeframe: Timeframe;
  detections: ScoredDetection[];
  /** Per-direction counts after filtering by `minConfidence`. */
  bullishCount: number;
  bearishCount: number;
  neutralCount: number;
  /** -100..+100 weighted bias (Σ(direction * confidence) normalised). */
  netBias: number;
  /** 0..100 strength of the single best-scoring detection. */
  topConfidence: number;
  /** The dominant category across active detections — used to colour the UI. */
  dominantCategory: PatternCategory | null;
  /** Free-text rollup; the LLM may quote it verbatim. */
  narrative: string;
}
