/**
 * Public surface of the candlestick intelligence subsystem.
 *
 * Importing from `@/lib/candlestick` (this barrel) bootstraps the detector
 * registry side-effectfully (via the import of `./detectors`) and exposes
 * the engine, multi-timeframe runner, types, and the classification table.
 */
export { runCandlestickEngine } from "./engine";
export type { EngineInput } from "./engine";
export {
  runMultiTimeframeCandlestick,
  flattenMultiTimeframe,
} from "./multi-tf";
export type {
  MultiTimeframeInput,
  MultiTimeframeResult,
} from "./multi-tf";
export { clearDetectionCache } from "./cache";
export {
  buildConfirmationContext,
  scoreDetection,
  type ConfirmationContext,
} from "./confidence";
export { DETECTORS, DETECTOR_COUNT } from "./detectors";
export { PATTERN_TAXONOMY, PATTERN_IDS } from "./classify";
export type {
  CandlestickIntelligence,
  ConfidenceBreakdown,
  PatternCategory,
  PatternDescriptor,
  PatternDirection,
  RawDetection,
  ScoredDetection,
} from "./types";
