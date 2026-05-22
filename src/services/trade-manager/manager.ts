import type {
  ManagedPositionContext,
  ManagementIndicators,
  ManagementAction,
  TradeManagementMeta,
  ManagementActionType,
} from "@/types/trade-management";
import { DEFAULT_MANAGEMENT_META, MANAGEMENT_CONSTANTS } from "@/types/trade-management";
import {
  calculateHealthScore,
  calculateDynamicConfidence,
  calculateConsecutiveAdverseCandles,
} from "./health-scorer";
import { checkEarlyExit } from "./exit-intelligence";
import { checkPartialExit } from "./partial-exit";
import { calculateDynamicLevels } from "./dynamic-levels";
import type { Candle } from "@/types/market";

interface ManagerResult {
  action: ManagementAction;
  updatedMeta: TradeManagementMeta;
}

/**
 * Evaluates a single position context and technical indicators to determine
 * the next management action (HOLD, ADJUST_TP, ADJUST_SL, TRAIL_SL, PARTIAL_EXIT, EARLY_EXIT).
 */
export function evaluatePosition(
  position: ManagedPositionContext,
  indicators: ManagementIndicators,
  closedCandles: Candle[],
  timeframe: string = "5m"
): ManagerResult {
  const now = Date.now();
  const createdAt = new Date(position.createdAt).getTime();
  const holdTime = now - createdAt;

  // 1. Calculate health score and dynamic confidence
  const health = calculateHealthScore(position, indicators);
  const { confidence: dynamicConfidence, trendState } = calculateDynamicConfidence(
    position,
    indicators,
    closedCandles,
    timeframe
  );

  // Override health.overall and health.smoothedScore with dynamic confidence
  health.overall = dynamicConfidence;
  health.smoothedScore = dynamicConfidence;

  // 2. Prepare the base management metadata updates
  const meta: TradeManagementMeta = position.managementMeta ?? { ...DEFAULT_MANAGEMENT_META };
  
  const healthHistory = [...(meta.healthHistory || [])];
  healthHistory.push(health.overall);
  if (healthHistory.length > MANAGEMENT_CONSTANTS.HEALTH_HISTORY_SIZE) {
    healthHistory.shift();
  }

  const confidenceHistory = [...(meta.confidenceHistory || [])];
  confidenceHistory.push(dynamicConfidence);
  if (confidenceHistory.length > 10) {
    confidenceHistory.shift();
  }

  const consecutiveAdverse = calculateConsecutiveAdverseCandles(closedCandles, position.side);

  const updatedMeta: TradeManagementMeta = {
    ...meta,
    healthHistory,
    confidenceHistory,
    consecutiveAdverseCandles: consecutiveAdverse,
    currentTrendState: trendState,
    confidenceScore: dynamicConfidence,
  };

  // 3. Run dynamic levels computation to keep trailing high-water mark updated at all times
  const levels = calculateDynamicLevels(position, indicators, health);
  updatedMeta.trailingStopHighWater = levels.metaUpdates.trailingStopHighWater;
  updatedMeta.trailingStopActive = levels.metaUpdates.trailingStopActive;
  updatedMeta.breakEvenTriggered = levels.metaUpdates.breakEvenTriggered;

  const lastClosedCandle = closedCandles.at(-1);
  const lastClosedCandleTime = lastClosedCandle?.time ? new Date(lastClosedCandle.time).getTime() : 0;
  
  // Cooldown check for level adjustments (TP/SL/Partial exits) based on candle interval
  const isCandleCooldownActive = lastClosedCandleTime > 0 && lastClosedCandleTime === meta.lastActionCandleTime;

  // Format dynamic metrics string to append to reasons
  const metricsStr = `| Confidence: ${dynamicConfidence}% | State: ${trendState} | Adverse Candles: ${consecutiveAdverse}`;

  // ─── Apply Guards & Cooldowns ───

  // A. Max total adjustments reached
  if ((meta.totalAdjustments ?? 0) >= MANAGEMENT_CONSTANTS.MAX_ADJUSTMENTS_PER_POSITION) {
    return {
      action: {
        type: "HOLD",
        confidence: 100,
        reason: `Max adjustments limit reached (20) ${metricsStr}`,
        healthScore: health,
      },
      updatedMeta,
    };
  }

  // B. Minimum hold time not met (let position settle)
  if (holdTime < MANAGEMENT_CONSTANTS.MIN_HOLD_BEFORE_MGMT_MS) {
    return {
      action: {
        type: "HOLD",
        confidence: 100,
        reason: `Min hold time not met. Settle period active (${Math.round((MANAGEMENT_CONSTANTS.MIN_HOLD_BEFORE_MGMT_MS - holdTime) / 1000)}s remaining) ${metricsStr}`,
        healthScore: health,
      },
      updatedMeta,
    };
  }

  // C. Global action cooldown check
  if (now - (meta.lastActionAt ?? 0) < MANAGEMENT_CONSTANTS.ACTION_COOLDOWN_MS) {
    return {
      action: {
        type: "HOLD",
        confidence: 100,
        reason: `Global action cooldown active ${metricsStr}`,
        healthScore: health,
      },
      updatedMeta,
    };
  }

  // ─── Pipeline Evaluation ───

  // 1. Early Exit Signals Check
  const exitAssessment = checkEarlyExit(position, indicators, closedCandles);
  if (exitAssessment.triggerExit && exitAssessment.confidence >= MANAGEMENT_CONSTANTS.MIN_EXIT_CONFIDENCE) {
    updatedMeta.lastActionAt = now;
    updatedMeta.totalAdjustments = (updatedMeta.totalAdjustments ?? 0) + 1;
    if (lastClosedCandleTime > 0) {
      updatedMeta.lastActionCandleTime = lastClosedCandleTime;
    }
    
    return {
      action: {
        type: "EARLY_EXIT",
        confidence: exitAssessment.confidence,
        reason: `${exitAssessment.reason} ${metricsStr}`,
        healthScore: health,
      },
      updatedMeta,
    };
  }

  // Cooldown check gate: if candle cooldown is active, prevent level adjustments (SL/TP/Partial Exits) and return HOLD
  if (isCandleCooldownActive) {
    return {
      action: {
        type: "HOLD",
        confidence: 100,
        reason: `Candle-level cooldown active for this interval (${new Date(lastClosedCandleTime).toISOString()}) ${metricsStr}`,
        healthScore: health,
      },
      updatedMeta,
    };
  }

  // 2. Partial Exit / Profit Scaling Check
  const partialAssessment = checkPartialExit(position, indicators, health);
  if (partialAssessment && partialAssessment.triggerPartial) {
    updatedMeta.lastActionAt = now;
    updatedMeta.totalAdjustments = (updatedMeta.totalAdjustments ?? 0) + 1;
    updatedMeta.partialExitsDone = partialAssessment.nextPartialIndex;
    if (lastClosedCandleTime > 0) {
      updatedMeta.lastActionCandleTime = lastClosedCandleTime;
    }

    return {
      action: {
        type: "PARTIAL_EXIT",
        quantity: partialAssessment.quantityToClose,
        confidence: 85,
        reason: `${partialAssessment.reason} ${metricsStr}`,
        healthScore: health,
      },
      updatedMeta,
    };
  }

  // 3. Dynamic Levels Check (SL prioritized, then TP)
  const currentSL = position.stopLoss;
  const currentTP = position.takeProfit;

  // A. Stop Loss Adjustments
  if (levels.stopLoss !== null && levels.stopLoss !== currentSL) {
    const isSlCooldownSatisfied = now - (meta.lastSlAdjustAt ?? 0) >= MANAGEMENT_CONSTANTS.SL_ADJUST_COOLDOWN_MS;
    
    if (isSlCooldownSatisfied) {
      updatedMeta.lastActionAt = now;
      updatedMeta.lastSlAdjustAt = now;
      updatedMeta.totalAdjustments = (updatedMeta.totalAdjustments ?? 0) + 1;
      if (lastClosedCandleTime > 0) {
        updatedMeta.lastActionCandleTime = lastClosedCandleTime;
      }

      let actionType: ManagementActionType = "ADJUST_SL";
      if (levels.reasons.some(r => r.includes("Trailing"))) {
        actionType = "TRAIL_SL";
      } else if (levels.reasons.some(r => r.includes("Break-even"))) {
        actionType = "BREAKEVEN_SL";
      }

      return {
        action: {
          type: actionType,
          newValue: levels.stopLoss,
          confidence: 80,
          reason: `${levels.reasons.filter(r => !r.includes("TP")).join(", ")} ${metricsStr}`,
          healthScore: health,
        },
        updatedMeta,
      };
    }
  }

  // B. Take Profit Adjustments
  if (levels.takeProfit !== null && levels.takeProfit !== currentTP) {
    const isTpCooldownSatisfied = now - (meta.lastTpAdjustAt ?? 0) >= MANAGEMENT_CONSTANTS.TP_ADJUST_COOLDOWN_MS;

    if (isTpCooldownSatisfied) {
      updatedMeta.lastActionAt = now;
      updatedMeta.lastTpAdjustAt = now;
      updatedMeta.totalAdjustments = (updatedMeta.totalAdjustments ?? 0) + 1;
      if (lastClosedCandleTime > 0) {
        updatedMeta.lastActionCandleTime = lastClosedCandleTime;
      }

      return {
        action: {
          type: "ADJUST_TP",
          newValue: levels.takeProfit,
          confidence: 75,
          reason: `${levels.reasons.filter(r => r.includes("TP") || r.includes("health")).join(", ")} ${metricsStr}`,
          healthScore: health,
        },
        updatedMeta,
      };
    }
  }

  // 4. Default: HOLD
  return {
    action: {
      type: "HOLD",
      confidence: 100,
      reason: `Position stable. No actions required. ${metricsStr}`,
      healthScore: health,
    },
    updatedMeta,
  };
}
