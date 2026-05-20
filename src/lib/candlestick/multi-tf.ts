import type { Candle, Timeframe } from "@/types/market";

import { runCandlestickEngine } from "./engine";
import type { ConfirmationContext } from "./confidence";
import type {
  CandlestickIntelligence,
  ScoredDetection,
} from "./types";

/**
 * Cross-timeframe orchestrator.
 *
 * Given a primary timeframe (e.g. 5m) and a map of additional timeframes
 * (typically 1m + 15m + 1h), we run the detection engine on each timeframe
 * and emit an enriched intelligence object where each primary-TF detection
 * carries a `higherTimeframeAlignment` flag set when a same-direction
 * detection fired on any higher TF within `htfWindowBars`.
 *
 * The HTF pass is computed AFTER the primary pass so we can patch the
 * `higherTimeframeAlignment` flag in-place rather than re-scoring.
 */
export interface MultiTimeframeInput {
  symbol: string;
  primary: { timeframe: Timeframe; candles: Candle[] };
  others: Partial<Record<Timeframe, Candle[]>>;
  /** Same `ConfirmationContext` map passed to `runCandlestickEngine`. */
  context?: Partial<ConfirmationContext>;
  /** Confidence floor for the primary intelligence emission. */
  minConfidence?: number;
  /** Confidence floor for HTF detections that count as agreement. */
  htfMinConfidence?: number;
}

export interface MultiTimeframeResult {
  primary: CandlestickIntelligence;
  htf: Record<Timeframe, CandlestickIntelligence>;
}

const TF_ORDER: Timeframe[] = ["1m", "5m", "15m", "1h", "4h", "1d"];

function rank(tf: Timeframe) {
  const idx = TF_ORDER.indexOf(tf);
  return idx === -1 ? 99 : idx;
}

export function runMultiTimeframeCandlestick(
  input: MultiTimeframeInput,
): MultiTimeframeResult {
  const {
    symbol,
    primary,
    others,
    context,
    minConfidence = 50,
    htfMinConfidence = 55,
  } = input;

  // Primary run first — we then mutate its `higherTimeframeAlignment` flags
  // using HTF outputs below.
  const primaryIntel = runCandlestickEngine({
    symbol,
    timeframe: primary.timeframe,
    candles: primary.candles,
    context,
    minConfidence,
  });

  const htf: Record<string, CandlestickIntelligence> = {};
  const primaryRank = rank(primary.timeframe);
  for (const tfKey of Object.keys(others) as Timeframe[]) {
    if (rank(tfKey) <= primaryRank) continue; // only HIGHER timeframes
    const candles = others[tfKey];
    if (!candles || candles.length < 14) continue;
    htf[tfKey] = runCandlestickEngine({
      symbol,
      timeframe: tfKey,
      candles,
      minConfidence: htfMinConfidence,
    });
  }

  // Patch primary detections with HTF agreement state.
  const patched = primaryIntel.detections.map((d) => {
    const agrees = Object.values(htf).some((h) =>
      h.detections.some(
        (hd) => hd.direction === d.direction && hd.confidenceScore >= htfMinConfidence,
      ),
    );
    if (agrees === d.higherTimeframeAlignment) return d;
    return { ...d, higherTimeframeAlignment: agrees };
  });

  return {
    primary: { ...primaryIntel, detections: patched },
    htf: htf as Record<Timeframe, CandlestickIntelligence>,
  };
}

/**
 * Collapse the multi-TF result into a flat list ordered by confidence —
 * convenient for the LLM payload and the UI banner.
 */
export function flattenMultiTimeframe(
  result: MultiTimeframeResult,
): ScoredDetection[] {
  const out: ScoredDetection[] = [...result.primary.detections];
  for (const intel of Object.values(result.htf)) out.push(...intel.detections);
  out.sort((a, b) => b.confidenceScore - a.confidenceScore);
  return out;
}
