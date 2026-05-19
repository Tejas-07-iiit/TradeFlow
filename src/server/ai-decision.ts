"use server";

import { z } from "zod";

import { getMarketDecisionFor } from "@/services/ai/reasoning/market-decision";
import {
  DecisionInputSchema,
  type DecisionInput,
  type MarketDecision,
  SentimentInputSchema,
  TradeDecisionSchema,
  type StrategySnapshotInput,
} from "@/services/ai/schemas";
import { runStrategyPipeline } from "@/strategy-core";
import type { StrategySnapshot } from "@/strategy-core/types";

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

  const result = await getMarketDecisionFor(parsed.data);
  if (!result) {
    return { ok: false, error: "LLM decision generation failed (see server logs)" };
  }

  return {
    ok: true,
    generatedAt: result.generatedAt,
    provider: result.provider,
    model: result.model,
    key: result.key,
    decision: result.decision,
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
    portfolio,
  };

  const llmResult = await getMarketDecisionFor(decisionInput);
  if (!llmResult) {
    return {
      ok: false,
      error: "LLM coordinator failed (see server logs)",
      strategySnapshot: decisionInput.strategySnapshot,
    };
  }

  return {
    ok: true,
    generatedAt: llmResult.generatedAt,
    provider: llmResult.provider,
    model: llmResult.model,
    key: llmResult.key,
    decision: llmResult.decision,
    strategySnapshot: decisionInput.strategySnapshot,
  };
}

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
    topStrategies: snapshot.topStrategies.map((r) => ({
      strategyId: r.output.strategyId,
      strategyName: r.output.strategyName,
      category: r.output.category,
      signal: r.output.signal,
      confidence: r.output.confidence,
      weightedScore: Math.round(r.weightedScore),
      regimeWeight: Math.round(r.regimeWeight * 100) / 100,
      reasoning: r.output.reasoning.slice(0, 3),
      momentumScore: Math.round(r.output.momentumScore),
      trendScore: Math.round(r.output.trendScore),
      volatilityScore: Math.round(r.output.volatilityScore),
      riskLevel: r.output.riskLevel,
    })),
    conflictingStrategies: snapshot.conflicting.slice(0, 5).map((o) => {
      const ranked = snapshot.ranked.find((r) => r.output.strategyId === o.strategyId);
      return {
        strategyId: o.strategyId,
        strategyName: o.strategyName,
        category: o.category,
        signal: o.signal,
        confidence: o.confidence,
        weightedScore: Math.round(ranked?.weightedScore ?? o.confidence),
        regimeWeight: Math.round((ranked?.regimeWeight ?? 1) * 100) / 100,
        reasoning: o.reasoning.slice(0, 2),
        momentumScore: Math.round(o.momentumScore),
        trendScore: Math.round(o.trendScore),
        volatilityScore: Math.round(o.volatilityScore),
        riskLevel: o.riskLevel,
      };
    }),
    relatedPrinciples: snapshot.relatedPrinciples.map((m) => ({
      name: m.name,
      classification: m.classification,
      coreLogic: m.coreLogic.slice(0, 280),
      sharpe: m.performance.sharpe,
    })),
  };
}
