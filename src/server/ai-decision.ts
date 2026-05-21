"use server";

import { z } from "zod";

import { submitDecisionJob, getOrchestratorStats } from "@/services/ai/orchestrator";
import {
  type CandlestickIntelligenceInput,
  DecisionInputSchema,
  type DecisionInput,
  type MarketDecision,
  SentimentInputSchema,
  TradeDecisionSchema,
  type StrategySnapshotInput,
} from "@/services/ai/schemas";
import type { CandlestickIntelligence } from "@/lib/candlestick";
import { runStrategyPipeline } from "@/strategy-core";
import type { StrategySnapshot } from "@/strategy-core/types";
import { validateNewsForTrade } from "@/services/news/validator";
import type { NewsValidationResult } from "@/services/news/validator-types";

export interface DecisionResponse {
  ok: boolean;
  /** ISO timestamp of when the decision was generated (cached or fresh). */
  generatedAt?: string;
  provider?: string;
  model?: string;
  /** Cache fingerprint, surfaced for client-side dedup / debugging. */
  key?: string;
  decision?: MarketDecision;
  error?: string;
  /** Optional snapshot returned to the client so the UI can render alignment. */
  strategySnapshot?: StrategySnapshotInput;
  /**
   * Where the decision came from.
   *   llm            — normal provider-chain answer.
   *   prefilter      — local rule short-circuited a flat snapshot.
   *   local-fallback — every LLM provider failed; deterministic engine
   *                    kept trading alive.
   * Lets the UI surface a badge and lets ops measure each path's hit rate.
   */
  source?: "llm" | "prefilter" | "local-fallback";
  newsValidation?: NewsValidationResult;
}

/**
 * Server action: ask the LLM for a trade decision on the supplied snapshot.
 *
 * Validates input server-side so the client cannot smuggle malformed payloads
 * past Zod, and never leaks the provider API key across the RSC boundary.
 *
 * Returns `{ ok: false, error }` on failure — the executor treats failure as
 * "no decision, do not act" rather than throwing into the React tree.
 *
 * Note: this is the *legacy* indicator-only entry. New callers should use
 * `getStrategyDecision` which runs the multi-strategy pipeline first.
 */
export async function getMarketDecision(
  input: DecisionInput,
): Promise<DecisionResponse> {
  const parsed = DecisionInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: `Invalid input: ${parsed.error.message}` };
  }

  const jobResult = await submitDecisionJob(parsed.data);
  if (!jobResult.ok || !jobResult.decision) {
    return {
      ok: false,
      error:
        jobResult.error ?? "Orchestrator returned no decision (see server logs)",
    };
  }

  const result = jobResult.decision;
  return {
    ok: true,
    generatedAt: result.generatedAt,
    provider: result.provider,
    model: result.model,
    key: result.key,
    decision: result.decision,
    source: result.source,
  };
}

const CandleSchema = z.object({
  time: z.number(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number(),
});

const StrategyDecisionInputSchema = z.object({
  symbol: z.string().min(1).max(20),
  timeframe: z.string().min(1).max(10),
  candles: z.array(CandleSchema).min(20).max(1000),
  sentiment: SentimentInputSchema.optional(),
  htfTrend: z.enum(["bullish", "bearish", "neutral"]).optional(),
  portfolio: z
    .object({
      accountBalance: z.number().nonnegative(),
      openPositionsCount: z.number().int().nonnegative(),
      hasOpenPositionThisSymbol: z.boolean(),
      lastDecisionForSymbol: TradeDecisionSchema.nullable().optional(),
    })
    .optional(),
});
export type StrategyDecisionInput = z.infer<typeof StrategyDecisionInputSchema>;

/**
 * Server action: run the full multi-strategy intelligence pipeline and pass
 * its structured output to the LLM coordinator.
 *
 * Flow:
 *   1. Validate input (Zod).
 *   2. `runStrategyPipeline` — evaluator → ranking → fusion → Quantpedia
 *      principle enrichment.
 *   3. Build `DecisionInput` with the snapshot attached and call the LLM.
 *   4. Return the LLM's decision + snapshot to the client.
 */
export async function getStrategyDecision(
  input: StrategyDecisionInput,
): Promise<DecisionResponse> {
  const parsed = StrategyDecisionInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: `Invalid input: ${parsed.error.message}` };
  }
  const { symbol, timeframe, candles, sentiment, htfTrend, portfolio } = parsed.data;

  const snapshot = await runStrategyPipeline({
    symbol,
    timeframe,
    candles,
    sentiment,
  });

  const lastClose = candles.at(-1)?.close;
  if (lastClose == null || lastClose <= 0) {
    return { ok: false, error: "no valid last close in candle window" };
  }

  const decisionInput: DecisionInput = {
    symbol,
    timeframe,
    price: lastClose,
    marketRegime: snapshot.regime,
    indicators: {
      ema50: snapshot.indicators.ema50,
      ema200: snapshot.indicators.ema200,
      rsi14: snapshot.indicators.rsi14,
      atr14: snapshot.indicators.atr14,
      adx14: snapshot.indicators.adx14,
      atrPct: snapshot.indicators.atrPct,
    },
    htfTrend,
    sentiment,
    strategySnapshot: projectSnapshotForPrompt(snapshot),
    // Only ship candlestick intel when at least one detection clears the
    // strong-signal floor. Empty / indecision-only intel on choppy intraday
    // bars was distracting the small 8B coordinator into HOLD/AVOID; the
    // optional field stays absent unless it can genuinely help the decision.
    candlestickIntelligence: shouldShipCandlestick(snapshot.candlestickIntel)
      ? projectCandlestickForPrompt(snapshot.candlestickIntel!)
      : undefined,
    portfolio,
  };

  // Route through the orchestrator — single point of LLM concurrency
  // control, priority queue, dedup, abort. Pipeline handles prefilter +
  // tier routing + local fallback identically to the direct call site.
  const jobResult = await submitDecisionJob(decisionInput);
  if (!jobResult.ok || !jobResult.decision) {
    return {
      ok: false,
      error:
        jobResult.error ?? "Orchestrator returned no decision (see server logs)",
      strategySnapshot: decisionInput.strategySnapshot,
    };
  }

  const llmResult = jobResult.decision;

  let newsValidation: NewsValidationResult | undefined;
  try {
    const decisionText = llmResult.decision.decision;
    const side = decisionText === "BUY" ? "LONG" : decisionText === "SELL" ? "SHORT" : "NONE";
    newsValidation = await validateNewsForTrade(symbol as any, side);
  } catch (err) {
    console.error(`[getStrategyDecision] news validation error for ${symbol}:`, err);
  }

  return {
    ok: true,
    generatedAt: llmResult.generatedAt,
    provider: llmResult.provider,
    model: llmResult.model,
    key: llmResult.key,
    decision: llmResult.decision,
    strategySnapshot: decisionInput.strategySnapshot,
    source: llmResult.source,
    newsValidation,
  };
}

/**
 * Strong-signal gate. Patterns are only worth the LLM's attention when at
 * least one detection scored >= 65 AND the dominant category is not pure
 * indecision. Otherwise the prompt's "patterns are context" framing was
 * making the coordinator over-rotate to HOLD on noisy intraday bars.
 */
function shouldShipCandlestick(
  intel: CandlestickIntelligence | undefined,
): intel is CandlestickIntelligence {
  if (!intel) return false;
  if (intel.detections.length === 0) return false;
  if (intel.topConfidence < 65) return false;
  if (intel.dominantCategory === "Indecision") return false;
  return true;
}

function projectCandlestickForPrompt(
  intel: CandlestickIntelligence,
): CandlestickIntelligenceInput {
  return {
    primaryTimeframe: intel.primaryTimeframe,
    detections: intel.detections
      .filter((d) => d.confidenceScore >= 65)
      .slice(0, 2)
      .map((d) => ({
      patternId: d.patternId,
      patternName: d.patternName,
      category: d.category,
      direction: d.direction,
      timeframe: d.timeframe,
      confidenceScore: Math.round(d.confidenceScore),
      patternStrength: Math.round(d.patternStrength),
      trendAlignment: d.trendAlignment,
      volumeConfirmation: d.volumeConfirmation,
      higherTimeframeAlignment: d.higherTimeframeAlignment,
      marketRegimeCompatibility: d.marketRegimeCompatibility,
      reasoning: d.reasoning,
    })),
    bullishCount: intel.bullishCount,
    bearishCount: intel.bearishCount,
    neutralCount: intel.neutralCount,
    netBias: Math.round(intel.netBias),
    topConfidence: Math.round(intel.topConfidence),
    dominantCategory: intel.dominantCategory,
    narrative: intel.narrative,
  };
}

/**
 * Compact projection sent to the LLM. Token-budget aware: every field
 * here costs tokens on every call and we hit Groq's TPM ceiling when the
 * payload bloats. Rules:
 *   - top 5 strategies (was 10), 1 reasoning line each (was 3)
 *   - top 3 conflicting strategies (was 5), 1 reasoning line each (was 2)
 *   - drop Quantpedia related-principles (saves ~600-1200 tokens per call)
 *   - drop momentum/trend/volatility per-strategy scores (the aggregate
 *     scores in the snapshot header already convey direction)
 */
function projectSnapshotForPrompt(snapshot: StrategySnapshot): StrategySnapshotInput {
  return {
    regime: snapshot.regime,
    netDirection: snapshot.netDirection,
    alignmentScore: snapshot.alignmentScore,
    aggregateMomentumScore: snapshot.aggregateMomentumScore,
    aggregateTrendScore: snapshot.aggregateTrendScore,
    aggregateVolatilityScore: snapshot.aggregateVolatilityScore,
    alignedCount: snapshot.aligned.length,
    conflictingCount: snapshot.conflicting.length,
    topStrategies: snapshot.topStrategies.slice(0, 5).map((r) => ({
      strategyId: r.output.strategyId,
      strategyName: r.output.strategyName,
      category: r.output.category,
      signal: r.output.signal,
      confidence: r.output.confidence,
      weightedScore: Math.round(r.weightedScore),
      regimeWeight: Math.round(r.regimeWeight * 100) / 100,
      reasoning: r.output.reasoning.slice(0, 1),
      momentumScore: Math.round(r.output.momentumScore),
      trendScore: Math.round(r.output.trendScore),
      volatilityScore: Math.round(r.output.volatilityScore),
      riskLevel: r.output.riskLevel,
    })),
    conflictingStrategies: snapshot.conflicting.slice(0, 3).map((o) => {
      const ranked = snapshot.ranked.find((r) => r.output.strategyId === o.strategyId);
      return {
        strategyId: o.strategyId,
        strategyName: o.strategyName,
        category: o.category,
        signal: o.signal,
        confidence: o.confidence,
        weightedScore: Math.round(ranked?.weightedScore ?? o.confidence),
        regimeWeight: Math.round((ranked?.regimeWeight ?? 1) * 100) / 100,
        reasoning: o.reasoning.slice(0, 1),
        momentumScore: Math.round(o.momentumScore),
        trendScore: Math.round(o.trendScore),
        volatilityScore: Math.round(o.volatilityScore),
        riskLevel: o.riskLevel,
      };
    }),
    relatedPrinciples: [],
  };
}

export async function getLiveOrchestratorStats(model?: string) {
  return getOrchestratorStats(model);
}
