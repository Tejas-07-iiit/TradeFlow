import { lastNumber, vwap as vwapSeries } from "@/lib/indicators/calculations";
import {
  runMultiTimeframeCandlestick,
  type CandlestickIntelligence,
} from "@/lib/candlestick";
import type { Timeframe } from "@/types/market";

import { StrategyRegistry } from "../registry";
import { buildIndicatorContext } from "../regime/indicator-context";
import { classifyRegime } from "../regime/classifier";
import type {
  IndicatorContext,
  MarketRegime,
  SentimentContext,
  StrategyContext,
  StrategyOutput,
} from "../types";
import { validateOutput } from "../validator";

export interface EvaluatorInput {
  symbol: string;
  timeframe: string;
  candles: import("@/types/market").Candle[];
  htfCandles?: Record<string, import("@/types/market").Candle[]>;
  sentiment?: SentimentContext;
}

export interface EvaluatorResult {
  outputs: StrategyOutput[];
  skipped: { strategyId: string; reason: string }[];
  regime: MarketRegime;
  indicators: IndicatorContext;
  candlestickIntel?: CandlestickIntelligence;
}

/**
 * Run every enabled strategy against the same context and collect the
 * outputs. Strategies are pure synchronous functions, so we don't bother
 * with `Promise.all` — the iteration is the parallelism boundary.
 *
 * Failures from a single strategy (a thrown exception or a malformed
 * output) are logged and the strategy is recorded as skipped — the
 * remaining strategies still produce a snapshot.
 */
export function evaluateAllStrategies(input: EvaluatorInput): EvaluatorResult {
  const indicators = buildIndicatorContext(input.candles);
  const regime = classifyRegime(indicators);
  const lastClose = input.candles.at(-1)?.close ?? 0;

  // Run the candlestick intelligence engine ONCE per tick, with HTF candles
  // routed in so the confidence engine can read same-direction confirmations
  // on higher timeframes. The result is shared with every strategy via
  // StrategyContext.candlestickIntel — strategies must NOT recompute.
  const candlestickIntel = computeCandlestickIntel(input, regime, indicators);

  const ctx: StrategyContext = {
    symbol: input.symbol,
    timeframe: input.timeframe,
    price: lastClose,
    candles: input.candles,
    htfCandles: input.htfCandles,
    indicators,
    regime,
    sentiment: input.sentiment,
    candlestickIntel,
  };

  const outputs: StrategyOutput[] = [];
  const skipped: { strategyId: string; reason: string }[] = [];

  for (const def of StrategyRegistry.enabled()) {
    if (input.candles.length < def.minCandles) {
      skipped.push({
        strategyId: def.id,
        reason: `needs ${def.minCandles} bars, have ${input.candles.length}`,
      });
      continue;
    }
    try {
      const raw = def.evaluate(ctx);
      const valid = validateOutput(raw);
      if (!valid.ok) {
        skipped.push({ strategyId: def.id, reason: valid.reason });
        continue;
      }
      outputs.push(valid.value);
    } catch (err) {
      skipped.push({
        strategyId: def.id,
        reason: err instanceof Error ? err.message : "throw",
      });
    }
  }

  return { outputs, skipped, regime, indicators, candlestickIntel };
}

function computeCandlestickIntel(
  input: EvaluatorInput,
  regime: MarketRegime,
  indicators: IndicatorContext,
): CandlestickIntelligence | undefined {
  if (input.candles.length < 14) return undefined;
  const vwap = lastNumber(vwapSeries(input.candles));
  try {
    const result = runMultiTimeframeCandlestick({
      symbol: input.symbol,
      primary: {
        timeframe: input.timeframe as Timeframe,
        candles: input.candles,
      },
      others: (input.htfCandles ?? {}) as Partial<Record<Timeframe, import("@/types/market").Candle[]>>,
      context: {
        ema50: indicators.ema50,
        ema200: indicators.ema200,
        rsi14: indicators.rsi14,
        adx14: indicators.adx14,
        atrPct: indicators.atrPct,
        vwap,
        regime,
      },
    });
    return result.primary;
  } catch (err) {
    console.error("[evaluator] candlestick engine failed:", err);
    return undefined;
  }
}
