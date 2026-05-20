/**
 * Job-priority computation.
 *
 * Called at submit time. Inputs are the validated `DecisionInput` (so we
 * have the strategy snapshot when available) plus the portfolio shape
 * already on the input. No I/O — must be pure so it can run in the
 * server action without blocking.
 *
 * Heuristic (highest priority wins):
 *   EXECUTION_CRITICAL  — open position with regime against the held side,
 *                         or near-SL distance (price within 0.4 × ATR of SL).
 *   POSITION_MGMT       — open position, no immediate crisis. Still
 *                         higher than any new-setup work.
 *   ELITE_SETUP         — alignment ≥ 80 AND |netDirection| ≥ 30.
 *   NEW_SETUP           — alignment ≥ 50 with directional bias.
 *   ROUTINE_SCAN        — default for everything else.
 *   RECHECK             — explicitly requested low-pri refresh (not used
 *                         from the standard path yet; reserved for Phase B).
 */

import type { DecisionInput, TradeDecision } from "../schemas";
import { JobPriority } from "./types";

// Position is "near SL" when the live price is within this fraction of
// ATR of the LLM's prior stop-loss level. Tighter than the executor's
// 0.5 ATR rule because we want headroom for the LLM to actually decide
// before the executor's hard SL fires.
const NEAR_SL_ATR_FRACTION = 0.4;

export function computeDecisionPriority(input: DecisionInput): JobPriority {
  const snap = input.strategySnapshot;
  const port = input.portfolio;
  const hasOpenPosition = !!port?.hasOpenPositionThisSymbol;

  if (hasOpenPosition) {
    if (isExecutionCritical(input)) return JobPriority.EXECUTION_CRITICAL;
    return JobPriority.POSITION_MGMT;
  }

  if (!snap) return JobPriority.ROUTINE_SCAN;

  if (snap.alignmentScore >= 80 && Math.abs(snap.netDirection) >= 30) {
    return JobPriority.ELITE_SETUP;
  }

  if (snap.alignmentScore >= 50 && Math.abs(snap.netDirection) >= 15) {
    return JobPriority.NEW_SETUP;
  }

  return JobPriority.ROUTINE_SCAN;
}

function isExecutionCritical(input: DecisionInput): boolean {
  const snap = input.strategySnapshot;
  const last = input.portfolio?.lastDecisionForSymbol;
  const atrPct = input.indicators.atrPct;
  const price = input.price;

  // Regime against the held side. If we entered long but the snapshot now
  // shows strong bearish bias, we need a decision fast.
  if (snap && last && isLong(last) && snap.netDirection < -25) return true;
  if (snap && last && isShort(last) && snap.netDirection > 25) return true;

  // Near-SL detection. We don't carry SL into DecisionInput directly, so
  // approximate via ATR — when atrPct is high the executor's hard SL is
  // proportionally closer and the LLM should re-evaluate before it fires.
  if (atrPct != null && price > 0 && atrPct > 3 * NEAR_SL_ATR_FRACTION) {
    return true;
  }

  return false;
}

function isLong(d: TradeDecision): boolean {
  return d === "BUY" || d.startsWith("BREAKOUT LONG") || d.startsWith("PULLBACK LONG") || d.startsWith("REVERSAL LONG");
}
function isShort(d: TradeDecision): boolean {
  return d === "SELL" || d.startsWith("BREAKDOWN SHORT");
}
