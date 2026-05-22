/**
 * Trade Management types — shared between the trade manager service,
 * server actions, and UI components.
 */

// ─── Health Score ────────────────────────────────────────────────────────────

export interface HealthScoreComponents {
  emaStructure: number;     // 0-100
  rsiStrength: number;
  macdMomentum: number;
  vwapPosition: number;
  volumeBehavior: number;
  volatility: number;
  candleStructure: number;
  marketRegime: number;
  newsSentiment: number;
  pnlBehavior: number;
}

export interface TradeHealthScore {
  /** Overall score 0-100 (weighted composite). */
  overall: number;
  /** Individual factor scores. */
  components: HealthScoreComponents;
  /** Trend direction based on last N scores. */
  trend: "improving" | "stable" | "deteriorating";
  /** EMA-smoothed score to prevent jitter. */
  smoothedScore: number;
}

// ─── Management Actions ─────────────────────────────────────────────────────

export type ManagementActionType =
  | "ADJUST_TP"
  | "ADJUST_SL"
  | "TRAIL_SL"
  | "BREAKEVEN_SL"
  | "PARTIAL_EXIT"
  | "EARLY_EXIT"
  | "HOLD";

export interface ManagementAction {
  type: ManagementActionType;
  newValue?: number;
  quantity?: number;          // for partial exits
  confidence: number;         // 0-100
  reason: string;
  healthScore: TradeHealthScore;
}

// ─── Ephemeral Management State ─────────────────────────────────────────────

export interface TradeManagementMeta {
  /** Last 10 raw health scores for trend detection. */
  healthHistory: number[];
  /** Epoch ms — last time ANY action was taken on this position. */
  lastActionAt: number;
  /** Epoch ms — last TP adjustment. */
  lastTpAdjustAt: number;
  /** Epoch ms — last SL adjustment. */
  lastSlAdjustAt: number;
  /** Number of partial exits completed (max 2). */
  partialExitsDone: number;
  /** Whether SL has been moved to breakeven. */
  breakEvenTriggered: boolean;
  /** Whether trailing stop is currently active. */
  trailingStopActive: boolean;
  /** High-water mark price for trailing stop calculation. */
  trailingStopHighWater: number;
  /** Total number of management adjustments made on this position. */
  totalAdjustments: number;

  // Adaptive TP/SL redesign tracking properties:
  consecutiveAdverseCandles?: number;
  lastActionCandleTime?: number;
  currentTrendState?: string;
  confidenceScore?: number;
  confidenceHistory?: number[];
  actionHistory?: string[];
  confidencePartialExitDone?: boolean;
}

export const DEFAULT_MANAGEMENT_META: TradeManagementMeta = {
  healthHistory: [],
  lastActionAt: 0,
  lastTpAdjustAt: 0,
  lastSlAdjustAt: 0,
  partialExitsDone: 0,
  breakEvenTriggered: false,
  trailingStopActive: false,
  trailingStopHighWater: 0,
  totalAdjustments: 0,
  consecutiveAdverseCandles: 0,
  lastActionCandleTime: 0,
  currentTrendState: "STABLE_TREND",
  confidenceScore: 100,
  confidenceHistory: [],
  actionHistory: [],
  confidencePartialExitDone: false,
};

// ─── Management Event (DB view) ─────────────────────────────────────────────

export type ManagementEventType =
  | "TP_ADJUSTED"
  | "SL_ADJUSTED"
  | "SL_TRAILED"
  | "SL_BREAKEVEN"
  | "PARTIAL_EXIT"
  | "EARLY_EXIT"
  | "HEALTH_UPDATE";

export interface TradeManagementEventView {
  id: string;
  type: ManagementEventType;
  oldValue: number | null;
  newValue: number | null;
  healthScore: number;
  confidence: number;
  reason: string;
  indicators: Record<string, unknown> | null;
  createdAt: string;
}

// ─── Position context for the manager ───────────────────────────────────────

export interface ManagedPositionContext {
  id: string;
  symbol: string;
  side: "LONG" | "SHORT";
  entryPrice: number;
  quantity: number;
  initialQuantity: number;
  takeProfit: number | null;
  stopLoss: number | null;
  originalTakeProfit: number | null;
  originalStopLoss: number | null;
  tradeHealthScore: number | null;
  managementMeta: TradeManagementMeta | null;
  marginUsed: number;
  createdAt: string;
  livePrice: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  // Position Sizing / Quality inputs:
  setupQuality?: string;
  qualityScore?: number;
}

// ─── Indicator snapshot for management decisions ────────────────────────────

export interface ManagementIndicators {
  ema50: number | null;
  ema200: number | null;
  rsi14: number | null;
  macd: { macd: number; signalLine: number; histogram: number } | null;
  macdPrev: { macd: number; signalLine: number; histogram: number } | null;
  atr14: number | null;
  atrPct: number | null;
  adx14: number | null;
  vwap: number | null;
  vwapSlope: -1 | 0 | 1;
  regime: string;
  bb: { upper: number; middle: number; lower: number } | null;
  volume: number;
  avgVolume: number;
  /** Candlestick pattern bias from the engine (-100 to +100). */
  candlestickBias: number;
  /** Dominant pattern category if any. */
  candlestickCategory: string | null;
  /** News aggregate class for the symbol. */
  newsClass: string | null;
  /** News aggregate score. */
  newsScore: number | null;
  newsTimestamp?: number | null;
}

// ─── Safety constants ───────────────────────────────────────────────────────

export const MANAGEMENT_CONSTANTS = {
  /** Evaluation interval in ms. */
  EVAL_INTERVAL_MS: 30_000,
  /** Minimum time after entry before management begins (ms). */
  MIN_HOLD_BEFORE_MGMT_MS: 120_000,
  /** Cooldown between any action on a single position (ms). */
  ACTION_COOLDOWN_MS: 60_000,
  /** Cooldown between TP adjustments (ms). */
  TP_ADJUST_COOLDOWN_MS: 120_000,
  /** Cooldown between SL adjustments (ms). */
  SL_ADJUST_COOLDOWN_MS: 90_000,
  /** Cooldown between partial exits (ms). */
  PARTIAL_EXIT_COOLDOWN_MS: 120_000,
  /** Minimum confidence to act on an adjustment. */
  MIN_ACTION_CONFIDENCE: 60,
  /** Minimum confidence to trigger early exit. */
  MIN_EXIT_CONFIDENCE: 70,
  /** Maximum total adjustments per position lifetime. */
  MAX_ADJUSTMENTS_PER_POSITION: 20,
  /** Maximum partial exits per position. */
  MAX_PARTIAL_EXITS: 2,
  /** Minimum percentage change to bother adjusting TP/SL. */
  MIN_CHANGE_THRESHOLD_PCT: 0.1,
  /** EMA smoothing factor for health score (0-1, lower = smoother). */
  HEALTH_SCORE_EMA_ALPHA: 0.3,
  /** Number of historical scores to keep for trend detection. */
  HEALTH_HISTORY_SIZE: 10,
  /** Health score below which TP is reduced. */
  TP_REDUCE_THRESHOLD: 50,
  /** Health score below which TP is aggressively reduced. */
  TP_AGGRESSIVE_REDUCE_THRESHOLD: 35,
  /** Minimum TP multiplier (TP distance cannot shrink below this fraction). */
  MIN_TP_MULTIPLIER: 0.6,
  /** Unrealized PnL threshold (as fraction of TP dist) for breakeven trigger. */
  BREAKEVEN_TRIGGER_PCT: 0.6,
  /** Unrealized PnL threshold (as fraction of TP dist) for profit protection. */
  PROFIT_PROTECT_TRIGGER_PCT: 0.8,
  /** Fraction of unrealized profit to lock in during profit protection. */
  PROFIT_PROTECT_LOCK_PCT: 0.4,
  /** Unrealized PnL threshold (as fraction of TP dist) for first partial exit. */
  PARTIAL_EXIT_1_TRIGGER_PCT: 0.6,
  /** Fraction of position to close on first partial exit. */
  PARTIAL_EXIT_1_SIZE: 0.5,
  /** Unrealized PnL threshold for second partial exit. */
  PARTIAL_EXIT_2_TRIGGER_PCT: 0.85,
  /** Fraction of REMAINING position to close on second partial exit. */
  PARTIAL_EXIT_2_SIZE: 0.5,
  /** ATR multiplier for trailing stop distance. */
  TRAILING_STOP_ATR_MULT: 2.5,
  /** ATR multiplier for breakeven buffer. */
  BREAKEVEN_BUFFER_ATR_MULT: 0.3,
  /** ATR multiplier for minimum SL distance from price. */
  MIN_SL_DISTANCE_ATR_MULT: 0.5,
  /** Maximum SL adjustment per cycle as fraction of remaining distance. */
  MAX_SL_ADJUST_PER_CYCLE_PCT: 0.15,
} as const;
