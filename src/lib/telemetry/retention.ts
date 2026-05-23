import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";

export interface TelemetryPruneResult {
  deletedRejectedCount: number;
  prunedAcceptedCount: number;
  success: boolean;
  error?: string;
}

/**
 * Telemetry Retention Policy:
 * 1. Permanently delete REJECTED signal logs older than daysToKeep (default: 30 days).
 *    Rejected logs are high frequency (noise) and have no matching filled trades.
 * 2. Prune (null-out) heavy JSON fields (strategySignals, familyBreakdown, reasoning,
 *    candlestickPatterns, newsValidation) from ACCEPTED or MODIFIED logs older than daysToKeep.
 *    This preserves the audit trail indices and summary metrics (symbol, side, finalAction,
 *    status, confidence, timestamp, slPrice, tpPrice, executionResult) while clearing 90%+
 *    of database storage space.
 */
export async function pruneTelemetryData(daysToKeep = 30): Promise<TelemetryPruneResult> {
  const cutoffDate = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000);
  
  try {
    // 1. Delete rejected logs older than cutoff
    const deleteRes = await prisma.explainableSignal.deleteMany({
      where: {
        status: "REJECTED",
        timestamp: { lt: cutoffDate },
      },
    });

    // 2. Null-out heavy JSON fields on accepted logs older than cutoff
    const pruneRes = await prisma.explainableSignal.updateMany({
      where: {
        status: { in: ["ACCEPTED", "MODIFIED", "SHADOW_ACCEPTED"] },
        timestamp: { lt: cutoffDate },
        OR: [
          { strategySignals: { not: Prisma.DbNull } },
          { familyBreakdown: { not: Prisma.DbNull } },
          { reasoning: { not: Prisma.DbNull } },
          { candlestickPatterns: { not: Prisma.DbNull } },
          { newsValidation: { not: Prisma.DbNull } },
        ],
      },
      data: {
        strategySignals: Prisma.DbNull,
        familyBreakdown: Prisma.DbNull,
        reasoning: Prisma.DbNull,
        candlestickPatterns: Prisma.DbNull,
        newsValidation: Prisma.DbNull,
      },
    });

    console.info(
      `[TELEMETRY-RETENTION] Pruned database entries older than ${daysToKeep} days. ` +
      `Deleted rejected noise logs: ${deleteRes.count}. Pruned accepted JSON payloads: ${pruneRes.count}.`
    );

    return {
      deletedRejectedCount: deleteRes.count,
      prunedAcceptedCount: pruneRes.count,
      success: true,
    };
  } catch (error) {
    console.error("[TELEMETRY-RETENTION-ERROR] Failed to execute database retention policy:", error);
    return {
      deletedRejectedCount: 0,
      prunedAcceptedCount: 0,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
