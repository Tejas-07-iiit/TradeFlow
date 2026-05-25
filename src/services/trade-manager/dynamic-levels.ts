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

function isSystemUnstable(confidenceHistory?: number[]): boolean {
  if (!confidenceHistory || confidenceHistory.length < 4) return false;
  let diffSum = 0;
  for (let i = 1; i < confidenceHistory.length; i++) {
    diffSum += Math.abs(confidenceHistory[i] - confidenceHistory[i - 1]);
  }
  const avgDiff = diffSum / (confidenceHistory.length - 1);
  return avgDiff > 15;
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
  const minChangeDelta = 0.25 * atr;
  
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

      // Late-stage trends reduce expansion expectations and tighten profit targets
      const createdTime = new Date(position.createdAt).getTime();
      const timeElapsed = Date.now() - createdTime;
      const timeframeMs = 5 * 60 * 1000; // default 5m
      const candlesElapsed = Math.floor(timeElapsed / timeframeMs);
      
      if (score < MANAGEMENT_CONSTANTS.TP_AGGRESSIVE_REDUCE_THRESHOLD) {
        tpMultiplier = MANAGEMENT_CONSTANTS.MIN_TP_MULTIPLIER; // 0.6
      } else if (score < MANAGEMENT_CONSTANTS.TP_REDUCE_THRESHOLD) {
        // Linear scale between 0.6 and 1.0 for health between 35 and 50
        const ratio = (score - MANAGEMENT_CONSTANTS.TP_AGGRESSIVE_REDUCE_THRESHOLD) / 
                      (MANAGEMENT_CONSTANTS.TP_REDUCE_THRESHOLD - MANAGEMENT_CONSTANTS.TP_AGGRESSIVE_REDUCE_THRESHOLD);
        tpMultiplier = MANAGEMENT_CONSTANTS.MIN_TP_MULTIPLIER + (1.0 - MANAGEMENT_CONSTANTS.MIN_TP_MULTIPLIER) * ratio;
      }

      if (candlesElapsed >= 25) {
        tpMultiplier = Math.min(tpMultiplier, 0.85); // Cap TP target closer to current price for late-stage trends
      }

      // Clamp multiplier
      tpMultiplier = Math.max(MANAGEMENT_CONSTANTS.MIN_TP_MULTIPLIER, Math.min(1.0, tpMultiplier));

      const targetTPDist = originalTPDist * tpMultiplier;
      const proposedTP = isLong ? entry + targetTPDist : entry - targetTPDist;

      // Enforce Minimum Change Delta check (>= 0.25 * ATR)
      if (currentTP === null || Math.abs(proposedTP - currentTP) >= minChangeDelta) {
        nextTP = proposedTP;
        if (tpMultiplier < 1.0) {
          reasons.push(`Reduced TP to ${(tpMultiplier * 100).toFixed(0)}% of original distance due to low health score (${score})`);
        }
      }
    }
  }

  // ─── 2. Dynamic Stop Loss (SL) Adjustment ──────────────
  if (currentSL !== null) {
    const isPositionInProfit = isLong ? livePrice > entry : livePrice < entry;
    
    // Calculate trade risk in R-multiple units
    const initialRisk = originalSL !== null ? Math.abs(entry - originalSL) : (atr * 2);
    const R = initialRisk > 0 ? initialRisk : (atr * 2);
    const unrealizedProfit = isPositionInProfit ? Math.abs(livePrice - entry) : 0;
    const profitR = unrealizedProfit / R;

    const originalTPDist = originalTP !== null ? Math.abs(originalTP - entry) : (atr * 5);
    const pnlFractionOfTP = originalTPDist > 0 ? (unrealizedProfit / originalTPDist) : 0;

    // Track potential new stop-loss candidates
    const slCandidates: { val: number; reason: string }[] = [];

    // A. Break-even Stop
    // Triggered by target distance OR if confidence has decayed into the 50%-59% band (confidence partial exit / scale-out)
    const confidenceDecayed = (health.overall >= 50 && health.overall <= 59) || position.managementMeta?.confidencePartialExitDone;
    if (isPositionInProfit && (pnlFractionOfTP >= MANAGEMENT_CONSTANTS.BREAKEVEN_TRIGGER_PCT || confidenceDecayed)) {
      const buffer = atr * MANAGEMENT_CONSTANTS.BREAKEVEN_BUFFER_ATR_MULT;
      const beLevel = isLong ? entry + buffer : entry - buffer;
      
      slCandidates.push({
        val: beLevel,
        reason: confidenceDecayed
          ? `Break-even stop activated due to confidence decay (${health.overall}%)`
          : `Break-even stop activated (PnL reached ${(pnlFractionOfTP * 100).toFixed(0)}% of TP distance)`,
      });
      breakEvenTriggered = true;
    }

    // B. Profit Protection Mode (R-multiple based stages)
    if (isPositionInProfit) {
      // Stage 1: +1R Profit -> tighten SL to lock in 0.25R
      if (profitR >= 1.0) {
        const tightLevel = isLong ? entry + (0.25 * R) : entry - (0.25 * R);
        slCandidates.push({
          val: tightLevel,
          reason: `Profit Protection Stage 1 (+1R): locked in 0.25R profit`,
        });
      }
      // Stage 2: +2R Profit -> partial profit lock (lock in 1.0R profit)
      if (profitR >= 2.0) {
        const lockLevel = isLong ? entry + (1.0 * R) : entry - (1.0 * R);
        slCandidates.push({
          val: lockLevel,
          reason: `Profit Protection Stage 2 (+2R): locked in 1.0R profit`,
        });
      }
      // Stage 3: +3R Profit -> aggressive trailing protection (lock in 2.0R profit)
      if (profitR >= 3.0) {
        const lockLevel3 = isLong ? entry + (2.0 * R) : entry - (2.0 * R);
        slCandidates.push({
          val: lockLevel3,
          reason: `Profit Protection Stage 3 (+3R): locked in 2.0R profit`,
        });
      }
    }

    // C. Trailing Stop (State-dependent and Quality-aware)
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

      // Base multiplier depends on Market Regime/State
      let baseTrailMult = 2.5;
      const regime = (indicators.regime || "").toLowerCase();
      if (regime.includes("volatility") || regime.includes("volatile")) {
        baseTrailMult = 4.0;
      } else if (regime.includes("trend")) {
        baseTrailMult = 3.5;
      } else if (regime.includes("choppy") || regime.includes("sideways") || regime.includes("range")) {
        baseTrailMult = 2.0;
      } else {
        baseTrailMult = 2.0; // low volatility / default sideways-like
      }

      let trailAtrMult = baseTrailMult;

      // Position quality adjustments
      const setupQuality = position.setupQuality || "C";
      if (setupQuality === "A+" || setupQuality === "A") {
        trailAtrMult += 0.5; // wider trailing room for high-quality setups
      } else if (setupQuality === "C") {
        trailAtrMult = Math.min(trailAtrMult, 1.8); // tighter trailing room for low-quality setups
      }

      // Trend maturity adjustments (Late-stage trend)
      const createdTime = new Date(position.createdAt).getTime();
      const timeElapsed = Date.now() - createdTime;
      const timeframeMs = 5 * 60 * 1000; // default 5m
      const candlesElapsed = Math.floor(timeElapsed / timeframeMs);
      if (candlesElapsed >= 25) {
        trailAtrMult = Math.min(trailAtrMult, 2.2); // tighten trailing stops for late-stage trends
      }

      // 3R aggressive trailing protection
      if (profitR >= 3.0) {
        trailAtrMult = Math.min(trailAtrMult, 1.8); // very tight trailing for massive winners
      }

      const trailDistance = atr * trailAtrMult;
      const trailLevel = isLong ? trailingHighWater - trailDistance : trailingHighWater + trailDistance;

      slCandidates.push({
        val: trailLevel,
        reason: `Trailing stop active (${trailAtrMult.toFixed(1)}x ATR). High water: ${trailingHighWater.toFixed(2)}, distance: ${trailDistance.toFixed(2)}`,
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
        
        // Slow down adjustments when system is unstable (clamp maxMove to 7% instead of 15%)
        const confidenceHistory = position.managementMeta?.confidenceHistory;
        const isUnstable = isSystemUnstable(confidenceHistory);
        const maxSlAdjustPct = isUnstable ? 0.07 : MANAGEMENT_CONSTANTS.MAX_SL_ADJUST_PER_CYCLE_PCT;

        const maxMove = currentRemainingDist * maxSlAdjustPct;
        
        if (isLong) {
          const proposedMove = finalProposedSL - currentSL;
          if (proposedMove > maxMove) {
            finalProposedSL = currentSL + maxMove;
            bestReason += ` (Clamped to max ${(maxSlAdjustPct * 100).toFixed(0)}% movement of ${maxMove.toFixed(2)})`;
          }
        } else {
          const proposedMove = currentSL - finalProposedSL;
          if (proposedMove > maxMove) {
            finalProposedSL = currentSL - maxMove;
            bestReason += ` (Clamped to max ${(maxSlAdjustPct * 100).toFixed(0)}% movement of ${maxMove.toFixed(2)})`;
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

        // Enforce Minimum Change Delta check (>= 0.25 * ATR)
        const isDeltaSignificant = Math.abs(finalProposedSL - currentSL) >= minChangeDelta;

        if ((finalImprovesLong || finalImprovesShort) && isDeltaSignificant) {
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
