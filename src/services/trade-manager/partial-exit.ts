import type {
  ManagedPositionContext,
  ManagementIndicators,
  TradeHealthScore,
} from "@/types/trade-management";
import { MANAGEMENT_CONSTANTS } from "@/types/trade-management";

interface PartialExitAssessment {
  triggerPartial: boolean;
  quantityToClose: number;
  reason: string;
  nextPartialIndex: number;
}

export function checkPartialExit(
  position: ManagedPositionContext,
  indicators: ManagementIndicators,
  health: TradeHealthScore
): PartialExitAssessment | null {
  const isLong = position.side === "LONG";
  const entry = position.entryPrice;
  const livePrice = position.livePrice;

  const currentTP = position.takeProfit;
  const originalTP = position.originalTakeProfit ?? currentTP;

  if (originalTP === null) return null;

  const originalTPDist = Math.abs(originalTP - entry);
  if (originalTPDist === 0) return null;

  const isPositionInProfit = isLong ? livePrice > entry : livePrice < entry;
  if (!isPositionInProfit) return null;

  const currentProfitDist = Math.abs(livePrice - entry);
  const pnlFractionOfTP = currentProfitDist / originalTPDist;

  const meta = position.managementMeta;
  const partialExitsDone = meta?.partialExitsDone ?? 0;
  const lastAction = meta?.lastActionAt ?? 0;
  const now = Date.now();

  // Cooldown check between partial exits / other management actions
  if (now - lastAction < MANAGEMENT_CONSTANTS.PARTIAL_EXIT_COOLDOWN_MS) {
    return null;
  }

  // Max 2 partial exits
  if (partialExitsDone >= MANAGEMENT_CONSTANTS.MAX_PARTIAL_EXITS) {
    return null;
  }

  // ─── First Partial Exit (50%) ───
  if (partialExitsDone === 0) {
    if (pnlFractionOfTP >= MANAGEMENT_CONSTANTS.PARTIAL_EXIT_1_TRIGGER_PCT && 
        health.smoothedScore >= 40) {
      
      const qtyToClose = position.initialQuantity * MANAGEMENT_CONSTANTS.PARTIAL_EXIT_1_SIZE;
      
      return {
        triggerPartial: true,
        quantityToClose: Math.min(qtyToClose, position.quantity),
        reason: `First partial exit (50% of initial size) triggered at ${(pnlFractionOfTP * 100).toFixed(0)}% of TP distance (health: ${health.smoothedScore})`,
        nextPartialIndex: 1,
      };
    }
  }

  // ─── Second Partial Exit (50% of remainder) ───
  if (partialExitsDone === 1) {
    if (pnlFractionOfTP >= MANAGEMENT_CONSTANTS.PARTIAL_EXIT_2_TRIGGER_PCT) {
      
      const qtyToClose = position.quantity * MANAGEMENT_CONSTANTS.PARTIAL_EXIT_2_SIZE;
      
      return {
        triggerPartial: true,
        quantityToClose: Math.min(qtyToClose, position.quantity),
        reason: `Second partial exit (50% of remaining size) triggered at ${(pnlFractionOfTP * 100).toFixed(0)}% of TP distance`,
        nextPartialIndex: 2,
      };
    }
  }

  return null;
}
