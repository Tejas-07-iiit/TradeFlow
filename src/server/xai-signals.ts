"use server";

import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";

/**
 * Persist a final trading signal (accepted, rejected, or modified)
 * with its complete analytical context.
 */
export async function saveExplainableSignal(data: Prisma.ExplainableSignalCreateInput) {
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
