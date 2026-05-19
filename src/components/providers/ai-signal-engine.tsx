"use client";

import { useEffect } from "react";
import { toast } from "sonner";

import { WATCHLIST_SYMBOLS } from "@/lib/market/symbols";
import { generateDecision } from "@/lib/signals/signal-engine";
import { createPaperOrder } from "@/server/trading";
import { useMarketStore } from "@/store/market-store";
import { useSignalStore } from "@/store/signal-store";

/**
 * Cooldown between auto-executions on the same symbol, regardless of
 * direction. Suppresses flap when the rule engine oscillates around a
 * threshold (BUY → HOLD → BUY → HOLD ...).
 */
const AUTO_EXEC_COOLDOWN_MS = 60_000;

/** When AI autonomy is on, the LLM (not the rule engine) owns execution. */
const AUTONOMY_FLAG = "on";

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
  const interval = useMarketStore((s) => s.interval);
  const candles = useMarketStore((s) => s.candles);

  const addSignal = useSignalStore((s) => s.addSignal);
  const checkExpirations = useSignalStore((s) => s.checkExpirations);

  useEffect(() => {
    // Snapshot store state once per tick — reading inside the loop is fine,
    // but pulling refs first keeps the loop body uniform.
    const signalState = useSignalStore.getState();
    const { markAutoExecuted, autoExec } = signalState;

    for (const symbol of WATCHLIST_SYMBOLS) {
      const bars = candles[`${symbol}:${interval}`];
      if (!bars || bars.length < 30) continue;

      const decision = generateDecision(symbol, candles, interval);
      if (decision.signal === "HOLD") continue;

      // 1) Persist into the signal store. Store dedupes ACTIVE same-type.
      addSignal(decision);

      // 2) Decide whether to fire a paper order — only when autonomy is OFF.
      // Once autonomy is ON the LLM-driven AiExecutionEngine owns trades.
      if (process.env.NEXT_PUBLIC_AI_AUTONOMY === AUTONOMY_FLAG) continue;
      if (decision.signal !== "BUY" && decision.signal !== "SELL") continue;
      if (decision.entryPrice == null) continue;

      const prev = autoExec[symbol];
      const sameTransition =
        prev && prev.signal === decision.signal && prev.type === decision.type;
      const cooldownActive =
        prev && Date.now() - prev.executedAt < AUTO_EXEC_COOLDOWN_MS;
      if (sameTransition) continue;
      if (cooldownActive) continue;

      // Mark first so concurrent ticks within the same render don't re-enter.
      markAutoExecuted(symbol, decision.signal, decision.type);
      createPaperOrder({
        symbol: decision.symbol,
        side: decision.signal === "BUY" ? "LONG" : "SHORT",
        type: "MARKET",
        quantity: 0.025,
        takeProfit: decision.takeProfit ?? undefined,
        stopLoss: decision.stopLoss ?? undefined,
        decisionSource: "RULE",
        decisionMeta: `${decision.type} @ confidence ${decision.confidence}`,
      })
        .then(() => {
          toast.success(
            `Rule engine ${decision.signal} ${decision.symbol} (${decision.type})`,
          );
        })
        .catch(() =>
          toast.error(`Rule auto-execute failed: ${decision.symbol}`),
        );
    }
  }, [candles, interval, addSignal]);

  useEffect(() => {
    const timer = setInterval(checkExpirations, 30_000);
    return () => clearInterval(timer);
  }, [checkExpirations]);

  return null;
}
