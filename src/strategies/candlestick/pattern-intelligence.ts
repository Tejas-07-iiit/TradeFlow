import type { ScoredDetection } from "@/lib/candlestick";
import type {
  StrategyContext,
  StrategyDefinition,
  StrategyOutput,
} from "@/strategy-core/types";

/**
 * Candlestick Intelligence — the framework-native voice of the 61-pattern
 * TA-Lib detection engine.
 *
 * This strategy DOES NOT trigger trades on patterns alone. It transforms the
 * `candlestickIntel` snapshot computed once per tick by the evaluator into a
 * single conviction-weighted vote that the fusion engine and LLM coordinator
 * consume *alongside* the other 11 analysts. A bullish reversal pattern in
 * isolation will be diluted; the same pattern aligned with trend, volume,
 * RSI, and a higher-timeframe confirmation produces a strong contribution.
 *
 * Direction comes from `netBias`. Confidence is the top-detection confidence
 * scaled by HTF agreement, regime fit, and conflict-with-other-patterns. Risk
 * level mirrors the dominant category — reversal/exhaustion = Medium-High;
 * continuation in trend = Low.
 */
function evaluate(ctx: StrategyContext): StrategyOutput {
  const intel = ctx.candlestickIntel;
  if (!intel || intel.detections.length === 0) {
    return shell({
      signal: "HOLD",
      confidence: 25,
      reasoning: ["No high-confidence candlestick patterns on the current bar."],
      momentumScore: 0,
      trendScore: 0,
    });
  }

  const top = intel.detections[0];
  const directionalDetections = intel.detections.filter(
    (d) => d.direction !== "neutral",
  );
  const bullScore = sum(directionalDetections.filter((d) => d.direction === "bullish"), (d) => d.confidenceScore);
  const bearScore = sum(directionalDetections.filter((d) => d.direction === "bearish"), (d) => d.confidenceScore);
  const dominant = bullScore > bearScore ? "bullish" : bearScore > bullScore ? "bearish" : "neutral";

  const reasoning: string[] = [];
  reasoning.push(intel.narrative);
  reasoning.push(
    `Composite bias ${intel.netBias > 0 ? "+" : ""}${intel.netBias}; top confidence ${top.confidenceScore} (${top.patternName}).`,
  );

  // Conflict penalty: if both sides have ≥ 30% of total weighted score, the
  // tape is ambivalent and conviction should drop.
  const conflictPenalty =
    bullScore > 0 && bearScore > 0
      ? Math.min(bullScore, bearScore) / Math.max(bullScore, bearScore)
      : 0;
  if (conflictPenalty > 0.4) {
    reasoning.push(`Conflicting bullish/bearish patterns (${conflictPenalty.toFixed(2)} ratio) — conviction reduced.`);
  }

  // Indecision tax: dominant category is Indecision → fade conviction.
  const indecisionTax = intel.dominantCategory === "Indecision" ? 0.8 : 1.0;
  if (indecisionTax < 1) {
    reasoning.push("Indecision patterns dominate — conviction discounted.");
  }

  // Base conviction = top.confidenceScore × HTF boost × conflict & indecision taxes.
  const htfBoost = top.higherTimeframeAlignment ? 1.1 : 1.0;
  let confidence = Math.round(top.confidenceScore * htfBoost * (1 - conflictPenalty * 0.5) * indecisionTax);
  confidence = Math.max(0, Math.min(95, confidence));

  // Strict directional gate. The candlestick analyst is *context*, not a
  // trigger — it abstains unless (a) composite conviction ≥ 70, (b) the top
  // detection is trend-aligned OR confirmed on a higher timeframe, and
  // (c) the top pattern is not an indecision category. This keeps it from
  // dragging consensus on noisy intraday tape.
  let signal: StrategyOutput["signal"] = "HOLD";
  const directionalEligible =
    confidence >= 70 &&
    top.category !== "Indecision" &&
    (top.trendAlignment === "with" || top.higherTimeframeAlignment);

  if (directionalEligible && dominant === "bullish" && top.direction === "bullish") {
    signal = "BUY";
  } else if (directionalEligible && dominant === "bearish" && top.direction === "bearish") {
    signal = "SELL";
  } else {
    reasoning.push(
      "Pattern evidence below the strict directional gate — abstaining as context-only.",
    );
  }

  const trendScore =
    dominant === "bullish"
      ? top.trendAlignment === "with"
        ? 60
        : top.trendAlignment === "against"
          ? -10
          : 30
      : dominant === "bearish"
        ? top.trendAlignment === "with"
          ? -60
          : top.trendAlignment === "against"
            ? 10
            : -30
        : 0;

  const momentumScore =
    top.category === "Momentum" || top.category === "Continuation"
      ? signal === "BUY"
        ? 50
        : signal === "SELL"
          ? -50
          : 0
      : trendScore * 0.5;

  return shell({
    signal,
    confidence,
    reasoning,
    momentumScore,
    trendScore,
  });
}

function shell(args: {
  signal: StrategyOutput["signal"];
  confidence: number;
  reasoning: string[];
  momentumScore: number;
  trendScore: number;
}): StrategyOutput {
  return {
    strategyId: "candlestick-intelligence",
    strategyName: "Candlestick Intelligence (TA-Lib 61)",
    category: "market-structure",
    signal: args.signal,
    confidence: Math.round(Math.min(95, Math.max(0, args.confidence))),
    timeframe: "intraday",
    regimeFit: ["Sideways", "Reversal", "Choppy", "Trending Up", "Trending Down", "Breakout"],
    riskLevel: "Medium",
    reasoning: args.reasoning,
    indicatorsUsed: ["TA-Lib CDL (61 patterns)", "Volume", "EMA50/EMA200", "RSI", "ADX", "VWAP", "HTF alignment"],
    entryConditions: [
      "Top scored detection direction = composite bias",
      "Composite confidence >= 55",
      "Higher-timeframe agreement boosts conviction",
    ],
    exitConditions: [
      "Opposite direction pattern with >= 65 confidence",
      "Top pattern's higherTimeframe alignment flips",
    ],
    stopLossLogic: "Tight stop just past the pattern bar's invalidating extreme.",
    takeProfitLogic: "Scaled by pattern category — reversals to nearest structure, continuations 1.5× ATR.",
    volatilityScore: 50,
    momentumScore: args.momentumScore,
    trendScore: args.trendScore,
  };
}

function sum<T>(arr: T[], pick: (t: T) => number): number {
  let total = 0;
  for (const t of arr) total += pick(t);
  return total;
}

export const CandlestickIntelligence: StrategyDefinition = {
  id: "candlestick-intelligence",
  name: "Candlestick Intelligence (TA-Lib 61)",
  category: "market-structure",
  description:
    "Voice of the 61-pattern TA-Lib candlestick engine — converts the per-bar scored detection set into a regime-aware, HTF-confirmed BUY/SELL/HOLD vote. Patterns are context, never a sole trigger.",
  timeframes: ["intraday"],
  preferredRegimes: ["Sideways", "Reversal", "Breakout", "Trending Up", "Trending Down"],
  minCandles: 30,
  evaluate,
  enabled: true,
};

/** Top-N scored detections, useful for the LLM prompt projection. */
export function topDetectionsForPrompt(
  list: ScoredDetection[],
  limit = 6,
): ScoredDetection[] {
  return [...list].sort((a, b) => b.confidenceScore - a.confidenceScore).slice(0, limit);
}
