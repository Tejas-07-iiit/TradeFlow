"use server";

import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";

/**
 * Optional gate hints supplied alongside the persist call. The server uses
 * these to suppress garbage rows BEFORE they hit the database — see
 * `shouldPersist` below for the rules.
 */
export interface PersistGateHints {
  /** Decision source — "local-fallback" rejections are usually noise. */
  source?: "llm" | "prefilter" | "local-fallback" | "cache" | string;
  /** Strategy alignment score (0-100) from the snapshot, when available. */
  alignmentScore?: number;
}

/**
 * In-memory dedup window — same (symbol, finalAction, status) within
 * DUP_WINDOW_MS skips persistence. Stops the spam where the same HOLD
 * decision is written every poll cycle while nothing changes.
 */
const DUP_WINDOW_MS = 60_000;
const recentWrites = new Map<string, number>();

function dedupKey(d: Prisma.ExplainableSignalCreateInput): string {
  return `${d.symbol}:${d.status}:${d.finalAction ?? d.side ?? "?"}`;
}

function isDuplicate(d: Prisma.ExplainableSignalCreateInput): boolean {
  const key = dedupKey(d);
  const at = recentWrites.get(key);
  if (at && Date.now() - at < DUP_WINDOW_MS) return true;
  recentWrites.set(key, Date.now());
  // Trim the map opportunistically to keep memory bounded.
  if (recentWrites.size > 256) {
    const cutoff = Date.now() - DUP_WINDOW_MS;
    for (const [k, t] of recentWrites) {
      if (t < cutoff) recentWrites.delete(k);
    }
  }
  return false;
}

/**
 * Persistence gate. Returns the reason for suppression (for log lines), or
 * `null` when the row is worth writing.
 *
 * Rules — only persist what's actually useful:
 *   1. Accepted trades are always written.
 *   2. Modified / shadow-accepted setups are always written.
 *   3. Rejected setups are written ONLY when:
 *        - they came from a real LLM call (not the local fallback), AND
 *        - confidence ≥ 50 OR alignment ≥ 70 (i.e. the rejection itself
 *          carries useful signal — "we *almost* took this trade").
 *   4. Duplicates within a 60-second window for the same (symbol, action,
 *      status) tuple are dropped.
 */
function shouldPersist(
  data: Prisma.ExplainableSignalCreateInput,
  hints: PersistGateHints,
): string | null {
  if (data.status === "ACCEPTED" || data.status === "MODIFIED" || data.status === "SHADOW_ACCEPTED") {
    if (isDuplicate(data)) return "duplicate within 60s";
    return null;
  }
  // REJECTED path — apply filters.
  if (hints.source === "local-fallback") {
    return "local-fallback rejection (noise)";
  }
  const conf = typeof data.confidence === "number" ? data.confidence : 0;
  const align = hints.alignmentScore ?? 0;
  if (conf < 50 && align < 70) {
    return `low-conviction rejection (conf=${conf}, align=${align})`;
  }
  if (isDuplicate(data)) return "duplicate within 60s";
  return null;
}

/**
 * Persist a final trading signal (accepted, rejected, or modified)
 * with its complete analytical context.
 *
 * Pass `hints` so the gate can suppress garbage rows — local-fallback
 * rejections, low-confidence rejections, and duplicate writes are
 * dropped silently (with a one-line log). Existing callers that don't
 * pass hints continue to work; their rows persist as before unless the
 * dedup window catches them.
 */
export async function saveExplainableSignal(
  data: Prisma.ExplainableSignalCreateInput,
  hints: PersistGateHints = {},
) {
  const suppressReason = shouldPersist(data, hints);
  if (suppressReason !== null) {
    console.info(
      `[XAI-PERSIST] suppressed ${data.symbol} ${data.status} — ${suppressReason}`,
    );
    return { ok: true, suppressed: true, reason: suppressReason };
  }
  try {
    const signal = await prisma.explainableSignal.create({
      data,
    });
    console.info(`[XAI-PERSIST] Saved explainable signal for ${data.symbol} - Status: ${data.status}`);
    return { ok: true, signal };
  } catch (error) {
    console.error("[XAI-PERSIST-ERROR] Failed to save explainable signal:", error);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Fetch list of final explainable signals with optional filters,
 * ordered by timestamp descending.
 */
export async function getExplainableSignals(filters?: { symbol?: string; status?: string }) {
  try {
    const where: Prisma.ExplainableSignalWhereInput = {};

    if (filters?.symbol && filters.symbol !== "ALL") {
      where.symbol = filters.symbol;
    }

    if (filters?.status && filters.status !== "ALL") {
      where.status = filters.status;
    }

    const signals = await prisma.explainableSignal.findMany({
      where,
      orderBy: {
        timestamp: "desc",
      },
    });
    return { ok: true, signals };
  } catch (error) {
    console.error("[XAI-FETCH-ERROR] Failed to retrieve explainable signals:", error);
    return { ok: false, error: error instanceof Error ? error.message : String(error), signals: [] };
  }
}

/**
 * Fetch detailed explainable reasoning for a specific signal by ID.
 */
export async function getExplainableSignalById(id: string) {
  try {
    const signal = await prisma.explainableSignal.findUnique({
      where: { id },
    });
    return { ok: true, signal };
  } catch (error) {
    console.error(`[XAI-FETCH-ERROR] Failed to retrieve signal ID ${id}:`, error);
    return { ok: false, error: error instanceof Error ? error.message : String(error), signal: null };
  }
}
