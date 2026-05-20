import { z } from "zod";

/**
 * Schemas for LLM outputs.
 *
 * Keep bounds tight: the model's freedom is the UI's risk. Cap string lengths
 * so a runaway response can't blow out the layout, and enum the
 * bias/quality fields so the UI can switch on them safely.
 */

export const MarketBiasSchema = z.enum([
  "strongly bearish",
  "moderately bearish",
  "neutral",
  "moderately bullish",
  "strongly bullish",
]);
export type MarketBias = z.infer<typeof MarketBiasSchema>;

export const SetupQualitySchema = z.enum(["A+", "A", "B+", "B", "C", "Avoid"]);
export type SetupQuality = z.infer<typeof SetupQualitySchema>;

export const RiskLevelSchema = z.enum(["Low", "Medium", "High"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

/**
 * The trade decision the LLM emits. Matches the user-visible setup taxonomy
 * the rule engine used, plus HOLD/AVOID as common no-trade outputs.
 *
 * AVOID is stricter than HOLD: HOLD = "wait", AVOID = "don't take this trade
 * even if it looks technically valid" (e.g. macro risk, regime fog). The
 * executor treats both as no-op, but downstream analytics can split them.
 */
export const TradeDecisionSchema = z.enum([
  "BUY",
  "SELL",
  "HOLD",
  "AVOID",
  "BREAKOUT LONG",
  "BREAKDOWN SHORT",
  "PULLBACK LONG",
  "REVERSAL LONG",
]);
export type TradeDecision = z.infer<typeof TradeDecisionSchema>;

export const LONG_DECISIONS: ReadonlySet<TradeDecision> = new Set([
  "BUY",
  "BREAKOUT LONG",
  "PULLBACK LONG",
  "REVERSAL LONG",
]);
export const SHORT_DECISIONS: ReadonlySet<TradeDecision> = new Set([
  "SELL",
  "BREAKDOWN SHORT",
]);
export const NO_TRADE_DECISIONS: ReadonlySet<TradeDecision> = new Set([
  "HOLD",
  "AVOID",
]);

export function decisionSide(d: TradeDecision): "LONG" | "SHORT" | null {
  if (LONG_DECISIONS.has(d)) return "LONG";
  if (SHORT_DECISIONS.has(d)) return "SHORT";
  return null;
}

export const MarketThesisSchema = z.object({
  marketBias: MarketBiasSchema,
  confidence: z.number().int().min(0).max(100),
  setupQuality: SetupQualitySchema,
  summary: z.string().min(20).max(400),
  riskCommentary: z.string().min(10).max(400),
  tradeThesis: z.string().min(20).max(500),
});
export type MarketThesis = z.infer<typeof MarketThesisSchema>;

/**
 * Optional sentiment fusion. Each field is graceful-optional so the call path
 * still works without news/sentiment providers wired up.
 */
export const SentimentInputSchema = z.object({
  newsSentiment: z
    .enum(["very bearish", "bearish", "neutral", "bullish", "very bullish"])
    .optional(),
  socialSentiment: z
    .enum(["very bearish", "bearish", "neutral", "bullish", "very bullish"])
    .optional(),
  /** 0 = extreme fear, 100 = extreme greed. */
  fearGreedIndex: z.number().int().min(0).max(100).optional(),
  /** Short, human-readable headlines fused into the prompt. Max 5. */
  headlines: z.array(z.string().min(3).max(180)).max(5).optional(),
});
export type SentimentInput = z.infer<typeof SentimentInputSchema>;

/**
 * Structured payload we feed the LLM. Kept flat and JSON-stringifiable so the
 * prompt template can pass it through without per-field formatting.
 */
export const ThesisInputSchema = z.object({
  symbol: z.string(),
  timeframe: z.string(),
  price: z.number(),
  marketRegime: z.string(),
  ruleSignal: z.enum(["BUY", "SELL", "HOLD"]),
  ruleConfidence: z.number().min(0).max(100),
  indicators: z.object({
    ema50: z.number().nullable(),
    ema200: z.number().nullable(),
    rsi14: z.number().nullable(),
    atr14: z.number().nullable(),
    adx14: z.number().nullable(),
    atrPct: z.number().nullable(),
  }),
  /** Optional higher-timeframe bias hint. */
  htfTrend: z.enum(["bullish", "bearish", "neutral"]).optional(),
  sentiment: SentimentInputSchema.optional(),
});
export type ThesisInput = z.infer<typeof ThesisInputSchema>;

/**
 * Strategy snapshot pushed into the LLM prompt.
 *
 * Kept structurally identical to the `StrategySnapshot` produced by
 * `runStrategyPipeline`, but with permissive enums so the schema doesn't
 * break if we add a new strategy category. The LLM consumes this as
 * structured analyst output and must not analyse raw candles directly.
 */
export const StrategySignalEntrySchema = z.object({
  strategyId: z.string(),
  strategyName: z.string(),
  category: z.string(),
  signal: z.enum(["BUY", "SELL", "HOLD"]),
  confidence: z.number().min(0).max(100),
  weightedScore: z.number(),
  regimeWeight: z.number(),
  reasoning: z.array(z.string()),
  momentumScore: z.number(),
  trendScore: z.number(),
  volatilityScore: z.number(),
  riskLevel: z.string(),
});
export type StrategySignalEntry = z.infer<typeof StrategySignalEntrySchema>;

/**
 * Structured candlestick intelligence projection.
 *
 * The Claude/Groq coordinator reads this block alongside `strategySnapshot`.
 * Patterns are *context* — the schema deliberately surfaces direction,
 * category, confidence, and key confirmation flags so the LLM can reason
 * about WHY a pattern fired (trend agree, HTF aligned, volume confirm) and
 * weight it accordingly. The LLM must NOT trade on patterns alone; the
 * coordinator prompt enforces that rule.
 */
export const CandlestickDetectionSchema = z.object({
  patternId: z.string().max(40),
  patternName: z.string().max(80),
  category: z.enum([
    "Bullish Reversal",
    "Bearish Reversal",
    "Continuation",
    "Indecision",
    "Momentum",
    "Exhaustion",
    "Breakout Confirmation",
  ]),
  direction: z.enum(["bullish", "bearish", "neutral"]),
  timeframe: z.string().max(8),
  confidenceScore: z.number().min(0).max(100),
  patternStrength: z.number().min(0).max(100),
  trendAlignment: z.enum(["with", "against", "neutral"]),
  volumeConfirmation: z.enum(["confirmed", "weak", "absent"]),
  higherTimeframeAlignment: z.boolean(),
  marketRegimeCompatibility: z.enum(["strong", "moderate", "weak"]),
  reasoning: z.string().min(3).max(280),
});
export type CandlestickDetectionInput = z.infer<typeof CandlestickDetectionSchema>;

export const CandlestickIntelligenceSchema = z.object({
  primaryTimeframe: z.string().max(8),
  detections: z.array(CandlestickDetectionSchema).max(8),
  bullishCount: z.number().int().nonnegative(),
  bearishCount: z.number().int().nonnegative(),
  neutralCount: z.number().int().nonnegative(),
  netBias: z.number().min(-100).max(100),
  topConfidence: z.number().min(0).max(100),
  dominantCategory: z
    .enum([
      "Bullish Reversal",
      "Bearish Reversal",
      "Continuation",
      "Indecision",
      "Momentum",
      "Exhaustion",
      "Breakout Confirmation",
    ])
    .nullable(),
  narrative: z.string().min(3).max(400),
});
export type CandlestickIntelligenceInput = z.infer<typeof CandlestickIntelligenceSchema>;

export const StrategySnapshotInputSchema = z.object({
  regime: z.string(),
  netDirection: z.number().min(-100).max(100),
  alignmentScore: z.number().min(0).max(100),
  aggregateMomentumScore: z.number(),
  aggregateTrendScore: z.number(),
  aggregateVolatilityScore: z.number(),
  alignedCount: z.number().int().nonnegative(),
  conflictingCount: z.number().int().nonnegative(),
  topStrategies: z.array(StrategySignalEntrySchema).max(10),
  conflictingStrategies: z.array(StrategySignalEntrySchema).max(10),
  relatedPrinciples: z
    .array(
      z.object({
        name: z.string(),
        classification: z.string(),
        coreLogic: z.string(),
        sharpe: z.string().optional(),
      }),
    )
    .max(5),
});
export type StrategySnapshotInput = z.infer<typeof StrategySnapshotInputSchema>;

/**
 * Decision-time input. Carries the same indicator context as ThesisInput plus
 * portfolio-aware fields the LLM uses to size and gate the trade.
 *
 * `accountBalance` and `openPositionsCount` let the model honor the risk
 * envelope; the executor still enforces hard caps regardless of what the
 * model returns. Treat the model's `positionSizePercent` as a *request*.
 *
 * `strategySnapshot` is the structured output of the multi-strategy
 * intelligence layer. When present, the LLM treats it as the primary
 * decision input; raw indicators stay in the payload only for sanity.
 */
export const DecisionInputSchema = z.object({
  symbol: z.string(),
  timeframe: z.string(),
  price: z.number().positive(),
  marketRegime: z.string(),
  indicators: z.object({
    ema50: z.number().nullable(),
    ema200: z.number().nullable(),
    rsi14: z.number().nullable(),
    atr14: z.number().nullable(),
    adx14: z.number().nullable(),
    atrPct: z.number().nullable(),
  }),
  htfTrend: z.enum(["bullish", "bearish", "neutral"]).optional(),
  recentPriceAction: z
    .object({
      higherHighs: z.boolean().optional(),
      lowerLows: z.boolean().optional(),
      breakoutDetected: z.boolean().optional(),
    })
    .optional(),
  sentiment: SentimentInputSchema.optional(),
  strategySnapshot: StrategySnapshotInputSchema.optional(),
  candlestickIntelligence: CandlestickIntelligenceSchema.optional(),
  portfolio: z
    .object({
      accountBalance: z.number().nonnegative(),
      openPositionsCount: z.number().int().nonnegative(),
      hasOpenPositionThisSymbol: z.boolean(),
      lastDecisionForSymbol: TradeDecisionSchema.nullable().optional(),
    })
    .optional(),
});
export type DecisionInput = z.infer<typeof DecisionInputSchema>;

/**
 * The autonomous trade decision the LLM returns.
 *
 * Bounds are enforced by the schema; the executor re-validates against its
 * own risk envelope before any paper order is created. If the model returns
 * an out-of-band TP/SL or oversized position, the order is rejected (not
 * silently clamped) so the LLM can learn the bound from a fresh decision.
 */
export const MarketDecisionSchema = z.object({
  decision: TradeDecisionSchema,
  confidence: z.number().int().min(0).max(100),
  setupQuality: SetupQualitySchema,
  riskLevel: RiskLevelSchema,
  /**
   * True only when decision is a directional action AND the model has
   * sufficient conviction. The executor still re-checks risk gates.
   */
  executeTrade: z.boolean(),
  /** Percent of available cash to commit. Hard-capped at 15. */
  positionSizePercent: z.number().min(0).max(100),
  expectedHoldTimeMinutes: z.number().int().min(5).max(240),
  entryPrice: z.number().positive(),
  takeProfit: z.number().positive(),
  stopLoss: z.number().positive(),
  // Reasoning kept tight on purpose — see the model's response-size
  // budget in `getMarketDecisionFor`. Looser bounds blew past the
  // completion limit on gpt-oss-120b; 4×200 char items is plenty for the
  // UI panel and stays well inside the 1800-token output cap.
  reasoning: z.array(z.string().min(5).max(200)).min(1).max(4),
  warnings: z.array(z.string().min(3).max(200)).max(3),
  marketSummary: z.string().min(20).max(300),
  /**
   * Strategy IDs from the snapshot that the LLM endorsed. The UI uses this
   * to highlight which analysts voted with the final call.
   */
  alignedStrategies: z.array(z.string().min(1).max(80)).max(6).optional(),
  conflictingStrategies: z.array(z.string().min(1).max(80)).max(6).optional(),
  /** Free-form market regime + condition commentary (institutional voice). */
  marketConditions: z.string().min(10).max(240).optional(),
  /** "execute immediately", "wait for confirmation candle", "skip", etc. */
  executionRecommendation: z.string().min(5).max(160).optional(),
});
export type MarketDecision = z.infer<typeof MarketDecisionSchema>;
