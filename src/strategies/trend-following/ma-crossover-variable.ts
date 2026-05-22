import {
  ema,
  lastNumber,
  rma,
  sma,
  vwma,
  wma,
} from "@/lib/indicators/calculations";
import type { StrategyContext, StrategyDefinition, StrategyOutput } from "@/strategy-core/types";

/**
 * Generic fast-vs-slow moving-average crossover (divonn1994 style).
 *
 * MA type and lengths are baked at module-scope so the strategy stays
 * deterministic and the registry can document them. The default 9-EMA / 21-EMA
 * is the most common community variant; we also compute the SMA/WMA/RMA/VWMA
 * variants so the LLM and explainability layer can show which families agree.
 */
const FAST_LEN = 9;
const SLOW_LEN = 21;

function evaluate(ctx: StrategyContext): StrategyOutput {
  const reasoning: string[] = [];
  const closes = ctx.candles.map((c) => c.close);
  if (closes.length < SLOW_LEN + 2) {
    return shell({
      signal: "HOLD",
      confidence: 25,
      reasoning: [`Need at least ${SLOW_LEN + 2} bars.`],
      trendScore: 0,
      agreement: 0,
    });
  }

  const families: Array<{ name: string; fast: number | null; slow: number | null }> = [
    { name: "EMA", fast: lastNumber(ema(closes, FAST_LEN)), slow: lastNumber(ema(closes, SLOW_LEN)) },
    { name: "SMA", fast: lastNumber(sma(closes, FAST_LEN)), slow: lastNumber(sma(closes, SLOW_LEN)) },
    { name: "WMA", fast: lastNumber(wma(closes, FAST_LEN)), slow: lastNumber(wma(closes, SLOW_LEN)) },
    { name: "RMA", fast: lastNumber(rma(closes, FAST_LEN)), slow: lastNumber(rma(closes, SLOW_LEN)) },
    { name: "VWMA", fast: lastNumber(vwma(ctx.candles, FAST_LEN)), slow: lastNumber(vwma(ctx.candles, SLOW_LEN)) },
  ];

  let bullCount = 0;
  let bearCount = 0;
  for (const f of families) {
    if (f.fast == null || f.slow == null) continue;
    if (f.fast > f.slow) bullCount += 1;
    else if (f.fast < f.slow) bearCount += 1;
  }
  const total = bullCount + bearCount;
  if (total === 0) {
    return shell({
      signal: "HOLD",
      confidence: 30,
      reasoning: ["No MA family stable yet."],
      trendScore: 0,
      agreement: 0,
    });
  }

  let signal: StrategyOutput["signal"] = "HOLD";
  let confidence = 40;
  let trendScore = 0;
  const agreement = Math.max(bullCount, bearCount) / total;

  if (bullCount >= 3 && bullCount > bearCount) {
    signal = "BUY";
    confidence = 50 + Math.round(agreement * 35);
    trendScore = Math.round(agreement * 70);
    reasoning.push(
      `${bullCount}/${total} MA families bullish at ${FAST_LEN}/${SLOW_LEN} (${(agreement * 100).toFixed(0)}% agreement).`,
    );
  } else if (bearCount >= 3 && bearCount > bullCount) {
    signal = "SELL";
    confidence = 50 + Math.round(agreement * 35);
    trendScore = -Math.round(agreement * 70);
    reasoning.push(
      `${bearCount}/${total} MA families bearish at ${FAST_LEN}/${SLOW_LEN} (${(agreement * 100).toFixed(0)}% agreement).`,
    );
  } else {
    reasoning.push(
      `Mixed MA families (${bullCount} bull / ${bearCount} bear) — no edge to lean on.`,
    );
  }

  return shell({ signal, confidence, reasoning, trendScore, agreement });
}

function shell(args: {
  signal: StrategyOutput["signal"];
  confidence: number;
  reasoning: string[];
  trendScore: number;
  agreement: number;
}): StrategyOutput {
  return {
    strategyId: "ma-crossover-variable",
    strategyName: `Variable MA Crossover (${FAST_LEN}/${SLOW_LEN})`,
    category: "trend-following",
    signal: args.signal,
    confidence: Math.round(Math.min(88, Math.max(0, args.confidence))),
    timeframe: "intraday",
    regimeFit: ["Trending Up", "Trending Down", "Breakout"],
    riskLevel: "Low",
    reasoning: args.reasoning,
    indicatorsUsed: ["EMA", "SMA", "WMA", "RMA", "VWMA"],
    entryConditions: [`Fast (${FAST_LEN}) crosses Slow (${SLOW_LEN}) on at least 3/5 MA families`],
    exitConditions: ["Opposite crossover", "Trailing stop at slow MA"],
    stopLossLogic: "Below slow MA on longs, above slow MA on shorts.",
    takeProfitLogic: "Trail trend until opposite crossover.",
    volatilityScore: 40,
    momentumScore: args.trendScore * 0.6,
    trendScore: args.trendScore,
  };
}

export const MaCrossoverVariable: StrategyDefinition = {
  id: "ma-crossover-variable",
  name: "Variable MA Crossover",
  category: "trend-following",
  description:
    "Multi-family MA crossover (SMA/EMA/WMA/RMA/VWMA) — only fires when at least three families agree, dramatically reducing single-MA whipsaws.",
  timeframes: ["intraday", "short-term"],
  preferredRegimes: ["Trending Up", "Trending Down", "Breakout"],
  minCandles: 30,
  evaluate,
  enabled: true,
};
