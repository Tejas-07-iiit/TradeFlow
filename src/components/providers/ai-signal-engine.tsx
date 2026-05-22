"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { toast } from "sonner";

import { WATCHLIST_SYMBOLS } from "@/lib/market/symbols";
import {
  calculateIndicators,
  generateDecision,
} from "@/lib/signals/signal-engine";
import {
  computeRiskAdjustedSize,
  type SetupQuality,
} from "@/lib/trading/position-sizing";
import { createPaperOrder } from "@/server/trading";
import { useMarketStore } from "@/store/market-store";
import { usePortfolioStore } from "@/store/portfolio-store";
import { useSignalStore } from "@/store/signal-store";

/**
 * Cooldown between auto-executions on the same symbol, regardless of
 * direction. Suppresses flap when the rule engine oscillates around a
 * threshold (BUY → HOLD → BUY → HOLD ...).
 */
const AUTO_EXEC_COOLDOWN_MS = 60_000;

/** When AI autonomy is on, the LLM (not the rule engine) owns execution. */
const AUTONOMY_FLAG = "on";

/** Max concurrent positions across the book. Mirrors the LLM engine. */
const MAX_OPEN_POSITIONS = 5;

/**
 * Rule-based signal engine. Always produces signals for display/context,
 * but only fires paper orders when AI autonomy is OFF — once autonomy is
 * ON, the LLM-driven AiExecutionEngine owns the trade decision and we'd
 * otherwise double-fire on every signal transition.
 *
 * Each tick scans every watchlist symbol (pure indicator math is cheap):
 *   1. Always feeds non-HOLD signals into the signal store for UI.
 *   2. **Only if autonomy is OFF** — fires a paper MARKET order on a signal
 *      transition (direction flipped, setup type changed, or last exec was
 *      a different signal AND the 60s cooldown elapsed).
 *
 * Sweeps signal expirations every 30s regardless.
 */
export function AiSignalEngine() {
  const router = useRouter();
  const interval = useMarketStore((s) => s.interval);
  const candles = useMarketStore((s) => s.candles);

  const addSignal = useSignalStore((s) => s.addSignal);
  const checkExpirations = useSignalStore((s) => s.checkExpirations);

  useEffect(() => {
    for (const symbol of WATCHLIST_SYMBOLS) {
      const bars = candles[`${symbol}:${interval}`];
      if (!bars || bars.length < 30) continue;

      const decision = generateDecision(symbol, candles, interval);
      if (decision.signal === "HOLD") continue;

      // Persist into the signal store for visual UI rendering
      addSignal(decision);
    }
  }, [candles, interval, addSignal]);

  useEffect(() => {
    const timer = setInterval(checkExpirations, 30_000);
    return () => clearInterval(timer);
  }, [checkExpirations]);

  return null;
}
