"use server";

import { computeRollingCorrelations } from "@/lib/telemetry/correlation";

/**
 * Server Action: Retrieve rolling strategy correlation diagnostics.
 */
export async function getRollingCorrelations(windowSize = 100) {
  try {
    const report = await computeRollingCorrelations(windowSize);
    return { ok: true, report };
  } catch (error) {
    console.error("[CORRELATION-ACTION-ERROR] Failed to fetch strategy correlations:", error);
    return { ok: false, error: error instanceof Error ? error.message : String(error), report: null };
  }
}
