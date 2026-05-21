import type {
  ManagedPositionContext,
  ManagementIndicators,
  TradeHealthScore,
} from "@/types/trade-management";
import { MANAGEMENT_CONSTANTS } from "@/types/trade-management";

interface AdjustedLevels {
  takeProfit: number | null;
  stopLoss: number | null;
  metaUpdates: {
    trailingStopHighWater: number;
    trailingStopActive: boolean;
    breakEvenTriggered: boolean;
  };
  reasons: string[];
}

export function calculateDynamicLevels(
  position: ManagedPositionContext,
  indicators: ManagementIndicators,
  health: TradeHealthScore
): AdjustedLevels {
  const isLong = position.side === "LONG";
  const entry = position.entryPrice;
  const livePrice = position.livePrice;

  const currentSL = position.stopLoss;
  const currentTP = position.takeProfit;
  const originalSL = position.originalStopLoss ?? currentSL;
  const originalTP = position.originalTakeProfit ?? currentTP;

  const atr = indicators.atr14 ?? (livePrice * 0.015); // Fallback to 1.5% if ATR is missing
  
  // Initialize output with current values
  let nextTP = currentTP;
  let nextSL = currentSL;
  const reasons: string[] = [];

  // Metadata flags
  let trailingHighWater = position.managementMeta?.trailingStopHighWater ?? 0;
  let trailingActive = position.managementMeta?.trailingStopActive ?? false;
  let breakEvenTriggered = position.managementMeta?.breakEvenTriggered ?? false;

  // ─── 1. Dynamic Take Profit (TP) Adjustment ──────────────
  if (originalTP !== null) {
    const originalTPDist = Math.abs(originalTP - entry);
    if (originalTPDist > 0) {
      let tpMultiplier = 1.0;
      const score = health.smoothedScore;

      if (score < MANAGEMENT_CONSTANTS.TP_AGGRESSIVE_REDUCE_THRESHOLD) {
        tpMultiplier = MANAGEMENT_CONSTANTS.MIN_TP_MULTIPLIER; // 0.6
      } else if (score < MANAGEMENT_CONSTANTS.TP_REDUCE_THRESHOLD) {
        // Linear scale between 0.6 and 1.0 for health between 35 and 50
        const ratio = (score - MANAGEMENT_CONSTANTS.TP_AGGRESSIVE_REDUCE_THRESHOLD) / 
                      (MANAGEMENT_CONSTANTS.TP_REDUCE_THRESHOLD - MANAGEMENT_CONSTANTS.TP_AGGRESSIVE_REDUCE_THRESHOLD);
        tpMultiplier = MANAGEMENT_CONSTANTS.MIN_TP_MULTIPLIER + (1.0 - MANAGEMENT_CONSTANTS.MIN_TP_MULTIPLIER) * ratio;
      }

      // Clamp multiplier
      tpMultiplier = Math.max(MANAGEMENT_CONSTANTS.MIN_TP_MULTIPLIER, Math.min(1.0, tpMultiplier));

      const targetTPDist = originalTPDist * tpMultiplier;
      const proposedTP = isLong ? entry + targetTPDist : entry - targetTPDist;

      // Only apply if change is above threshold
      if (currentTP === null || Math.abs(proposedTP - currentTP) / currentTP >= (MANAGEMENT_CONSTANTS.MIN_CHANGE_THRESHOLD_PCT / 100)) {
        nextTP = proposedTP;
        if (tpMultiplier < 1.0) {
          reasons.push(`Reduced TP to ${(tpMultiplier * 100).toFixed(0)}% of original distance due to low health score (${score})`);
        }
      }
    }
  }

  // ─── 2. Dynamic Stop Loss (SL) Adjustment ──────────────
  if (currentSL !== null) {
    const originalTPDist = originalTP !== null ? Math.abs(originalTP - entry) : (atr * 5);
    const pnlFractionOfTP = originalTPDist > 0 ? (Math.abs(livePrice - entry) / originalTPDist) : 0;
    const isPositionInProfit = isLong ? livePrice > entry : livePrice < entry;

    // Track potential new stop-loss candidates
    const slCandidates: { val: number; reason: string }[] = [];

    // A. Break-even Stop
    if (isPositionInProfit && pnlFractionOfTP >= MANAGEMENT_CONSTANTS.BREAKEVEN_TRIGGER_PCT) {
      const buffer = atr * MANAGEMENT_CONSTANTS.BREAKEVEN_BUFFER_ATR_MULT;
      const beLevel = isLong ? entry + buffer : entry - buffer;
      
      slCandidates.push({
        val: beLevel,
        reason: `Break-even stop activated (PnL reached ${(pnlFractionOfTP * 100).toFixed(0)}% of TP distance)`,
      });
      breakEvenTriggered = true;
    }

    // B. Profit Protection
    if (isPositionInProfit && pnlFractionOfTP >= MANAGEMENT_CONSTANTS.PROFIT_PROTECT_TRIGGER_PCT) {
      const profitToLock = Math.abs(livePrice - entry) * MANAGEMENT_CONSTANTS.PROFIT_PROTECT_LOCK_PCT;
      const lockLevel = isLong ? entry + profitToLock : entry - profitToLock;

      slCandidates.push({
        val: lockLevel,
        reason: `Locked in ${(MANAGEMENT_CONSTANTS.PROFIT_PROTECT_LOCK_PCT * 100).toFixed(0)}% of unrealized profit (PnL reached ${(pnlFractionOfTP * 100).toFixed(0)}% of TP distance)`,
      });
    }

    // C. Trailing Stop
    // Activate trailing stop if price has moved in our favor by at least 1.5 ATR
    if (isPositionInProfit && (Math.abs(livePrice - entry) >= atr * 1.5 || trailingActive)) {
      trailingActive = true;
      
      // Update high-water mark
      if (trailingHighWater === 0) {
        trailingHighWater = livePrice;
      } else {
        trailingHighWater = isLong
          ? Math.max(trailingHighWater, livePrice)
          : Math.min(trailingHighWater, livePrice);
      }

      const trailDistance = atr * MANAGEMENT_CONSTANTS.TRAILING_STOP_ATR_MULT;
      const trailLevel = isLong ? trailingHighWater - trailDistance : trailingHighWater + trailDistance;

      slCandidates.push({
        val: trailLevel,
        reason: `Trailing stop active. High water mark: ${trailingHighWater.toFixed(2)}, trail distance: ${trailDistance.toFixed(2)}`,
      });
    }

    // D. Health-based tightening
    if (health.smoothedScore < 30) {
      const remainingDist = Math.abs(livePrice - currentSL);
      const tightenAmt = remainingDist * 0.20;
      const tightenLevel = isLong ? currentSL + tightenAmt : currentSL - tightenAmt;

      slCandidates.push({
        val: tightenLevel,
        reason: `Emergency health tightening: health score is critical (${health.smoothedScore})`,
      });
    }

    // Process candidates and choose the one that tightens the stop loss the most
    if (slCandidates.length > 0) {
      let bestCandidate = currentSL;
      let bestReason = "";

      for (const candidate of slCandidates) {
        const val = candidate.val;
        
        // Safety validation: Monotonic tightening only (LONG: SL must increase; SHORT: SL must decrease)
        const improvesLong = isLong && val > bestCandidate;
        const improvesShort = !isLong && val < bestCandidate;

        if (improvesLong || improvesShort) {
          bestCandidate = val;
          bestReason = candidate.reason;
        }
      }

      if (bestCandidate !== currentSL) {
        let finalProposedSL = bestCandidate;

        // Apply Maximum adjustment per cycle limit: 15% of remaining distance to price
        const currentRemainingDist = Math.abs(livePrice - currentSL);
        const maxMove = currentRemainingDist * MANAGEMENT_CONSTANTS.MAX_SL_ADJUST_PER_CYCLE_PCT;
        
        if (isLong) {
          const proposedMove = finalProposedSL - currentSL;
          if (proposedMove > maxMove) {
            finalProposedSL = currentSL + maxMove;
            bestReason += ` (Clamped to max 15% movement of ${maxMove.toFixed(2)})`;
          }
        } else {
          const proposedMove = currentSL - finalProposedSL;
          if (proposedMove > maxMove) {
            finalProposedSL = currentSL - maxMove;
            bestReason += ` (Clamped to max 15% movement of ${maxMove.toFixed(2)})`;
          }
        }

        // Apply Minimum SL distance guard from current price (to avoid immediate noise stop-outs)
        const minDistance = atr * MANAGEMENT_CONSTANTS.MIN_SL_DISTANCE_ATR_MULT;
        if (isLong) {
          const maxAllowedSL = livePrice - minDistance;
          if (finalProposedSL > maxAllowedSL) {
            finalProposedSL = maxAllowedSL;
            bestReason += ` (Clamped to min distance of ${minDistance.toFixed(2)} from price)`;
          }
        } else {
          const minAllowedSL = livePrice + minDistance;
          if (finalProposedSL < minAllowedSL) {
            finalProposedSL = minAllowedSL;
            bestReason += ` (Clamped to min distance of ${minDistance.toFixed(2)} from price)`;
          }
        }

        // Final sanity check: make sure the final proposed SL is still better than current SL
        const finalImprovesLong = isLong && finalProposedSL > currentSL;
        const finalImprovesShort = !isLong && finalProposedSL < currentSL;

        if (finalImprovesLong || finalImprovesShort) {
          nextSL = finalProposedSL;
          reasons.push(bestReason);
        }
      }
    }
  }

  return {
    takeProfit: nextTP,
    stopLoss: nextSL,
    metaUpdates: {
      trailingStopHighWater: trailingHighWater,
      trailingStopActive: trailingActive,
      breakEvenTriggered: breakEvenTriggered,
    },
    reasons,
  };
}
