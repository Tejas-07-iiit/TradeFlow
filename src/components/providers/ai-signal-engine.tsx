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
    // Snapshot store state once per tick — reading inside the loop is fine,
    // but pulling refs first keeps the loop body uniform.
    const signalState = useSignalStore.getState();
    const { markAutoExecuted, autoExec } = signalState;
    const portfolio = usePortfolioStore.getState();
    const availableBalance = portfolio.walletBalance - portfolio.usedMargin;
    const unrealized = portfolio.positions.reduce(
      (s, p) => s + (p.unrealizedPnl ?? 0),
      0,
    );
    const totalEquity = portfolio.walletBalance + unrealized;
    const exposure = {
      totalOpenNotional: portfolio.positions.reduce(
        (s, p) =>
          p.status === "OPEN" || p.status === "PARTIALLY_CLOSED"
            ? s + p.quantity * p.entryPrice
            : s,
        0,
      ),
      openPositionsCount: portfolio.positions.filter(
        (p) => p.status === "OPEN" || p.status === "PARTIALLY_CLOSED",
      ).length,
    };

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
      // Risk-based sizing needs an SL; if the rule didn't emit one we can't
      // produce a sensible quantity. Skip rather than guess.
      if (decision.stopLoss == null || decision.takeProfit == null) {
        console.info(
          `[RISK] rule skipped ${decision.symbol} — missing TP/SL`,
        );
        continue;
      }

      // Hard rule: never open a second position on a symbol that already has
      // one open, regardless of source (rule, LLM, manual).
      const alreadyOpen = portfolio.positions.some(
        (p) =>
          p.symbol === symbol &&
          (p.status === "OPEN" || p.status === "PARTIALLY_CLOSED"),
      );
      if (alreadyOpen) {
        console.info(`[RISK] rule skipped ${symbol} — already open`);
        continue;
      }

      const prev = autoExec[symbol];
      const sameTransition =
        prev && prev.signal === decision.signal && prev.type === decision.type;
      const cooldownActive =
        prev && Date.now() - prev.executedAt < AUTO_EXEC_COOLDOWN_MS;
      if (sameTransition) continue;
      if (cooldownActive) continue;

      const perSymbolOpenNotional = portfolio.positions.reduce(
        (s, p) =>
          p.symbol === symbol &&
          (p.status === "OPEN" || p.status === "PARTIALLY_CLOSED")
            ? s + p.quantity * p.entryPrice
            : s,
        0,
      );
      // Indicator snapshot for regime + ATR%.
      const indicators = calculateIndicators(bars);
      const last = bars.at(-1);
      const atrPct =
        last && last.close > 0 && "atrPct" in last
          ? (last as { atrPct?: number }).atrPct ?? null
          : null;

      // Map rule grade ("A+"/"A"/"B"/"C") to the shared sizing enum.
      const ruleGrade: SetupQuality =
        decision.setupQuality === "B"
          ? "B"
          : (decision.setupQuality as SetupQuality);

      const side: "LONG" | "SHORT" = decision.signal === "BUY" ? "LONG" : "SHORT";
      const sizing = computeRiskAdjustedSize({
        symbol: decision.symbol,
        side,
        livePrice: decision.entryPrice,
        stopLossPrice: decision.stopLoss,
        takeProfitPrice: decision.takeProfit,
        totalEquity,
        availableBalance,
        confidence: decision.confidence,
        setupQuality: ruleGrade,
        marketRegime: indicators.regime ?? undefined,
        atrPct,
        decisionType: decision.type,
        exposure: {
          totalOpenNotional: exposure.totalOpenNotional,
          perSymbolOpenNotional,
          openPositionsCount: exposure.openPositionsCount,
        },
        maxOpenPositions: MAX_OPEN_POSITIONS,
      });
      if (sizing.rejection) {
        console.warn(
          `[RISK] rule ${decision.symbol} sized-out (${sizing.rejection}) — ${sizing.rationale}`,
        );
        continue;
      }

      // Mark first so concurrent ticks within the same render don't re-enter.
      markAutoExecuted(symbol, decision.signal, decision.type);
      console.info(
        `[EXECUTION] rule ${decision.signal} ${decision.symbol} qty=${sizing.quantity} notional=${sizing.notional.toFixed(2)} risk=$${sizing.riskAmount.toFixed(0)} target=+$${sizing.expectedProfit.toFixed(0)} RR=${sizing.riskRewardRatio.toFixed(2)} eq=${sizing.equityPercent.toFixed(1)}%`,
      );
      console.info(`[EXECUTION] rationale → ${sizing.rationale}`);
      const meta = JSON.stringify({
        decision: decision.type,
        confidence: decision.confidence,
        setupQuality: decision.setupQuality,
        sizing: {
          notional: Number(sizing.notional.toFixed(2)),
          riskAmount: Number(sizing.riskAmount.toFixed(2)),
          riskPercent: Number(sizing.riskPercent.toFixed(3)),
          equityPercent: Number(sizing.equityPercent.toFixed(2)),
          expectedProfit: Number(sizing.expectedProfit.toFixed(2)),
          expectedLoss: Number(sizing.expectedLoss.toFixed(2)),
          rr: Number(sizing.riskRewardRatio.toFixed(2)),
          rationale: sizing.rationale,
          multipliers: sizing.multipliers,
        },
      });
      createPaperOrder({
        symbol: decision.symbol,
        side,
        type: "MARKET",
        quantity: sizing.quantity,
        takeProfit: decision.takeProfit ?? undefined,
        stopLoss: decision.stopLoss ?? undefined,
        decisionSource: "RULE",
        decisionMeta: meta,
        blockIfAlreadyOpen: true,
      })
        .then(() => {
          toast.success(
            `Rule engine ${decision.signal} ${decision.symbol} (${decision.type})`,
          );
          router.refresh();
        })
        .catch((err) => {
          console.error(
            `[EXECUTION] rule fire failed for ${decision.symbol}:`,
            err instanceof Error ? err.message : err,
          );
          toast.error(`Rule auto-execute failed: ${decision.symbol}`);
        });
    }
  }, [candles, interval, addSignal, router]);

  useEffect(() => {
    const timer = setInterval(checkExpirations, 30_000);
    return () => clearInterval(timer);
  }, [checkExpirations]);

  return null;
}
