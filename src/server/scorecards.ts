"use server";

import { auth } from "@/lib/auth";
import { computeStrategyScorecards } from "@/lib/strategies/scorecard";

/**
 * Server Action: Retrieve quantitative rolling strategy scorecards for the active user's trades.
 */
export async function getStrategyScorecards() {
  try {
    const session = await auth();
    // Default to active user's trades for scorecard analytics
    const userId = session?.user?.id;
    const scorecards = await computeStrategyScorecards(userId);
    return { ok: true, scorecards };
  } catch (error) {
    console.error("[SCORECARDS-ACTION-ERROR] Failed to fetch strategy scorecards:", error);
    return { ok: false, error: error instanceof Error ? error.message : String(error), scorecards: [] };
  }
}
