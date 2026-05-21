"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { toast } from "sonner";

import {
  assessTradeQuality,
  type TradeAssessment,
  type TradeProposal,
} from "@/lib/trade-quality";
import { calculateIndicators } from "@/lib/signals/signal-engine";
import { computeRiskAdjustedSize } from "@/lib/trading/position-sizing";
import { closePaperPosition, createPaperOrder } from "@/server/trading";
import { decisionSide } from "@/services/ai/schemas";
import { useAiDecisionStore, type DecisionEntry } from "@/store/ai-decision-store";
import { useMarketStore } from "@/store/market-store";
import { usePortfolioStore } from "@/store/portfolio-store";
import type { PaperPositionView } from "@/types/portfolio";

/**
 * Autonomous LLM execution engine.
 *
 * Two paths:
 *   - Entry: build a `TradeProposal` from the LLM decision + live state, run
 *     it through `assessTradeQuality()`, fire the order on approval or log a
 *     structured rejection otherwise.
 *   - Exit:  close an LLM-owned position when the LLM flips its view.
 *
 * Hard-gated by `NEXT_PUBLIC_AI_AUTONOMY`. While "off" the engine still scores
 * incoming decisions and emits rejection log entries, but never sends orders —
 * so the operator can watch what *would* have traded without committing
 * capital.
 *
 * The validator / scorer themselves live in `src/lib/trade-quality/` and are
 * pure. This component is the thin glue between the LLM decision store, the
 * live market store, and the trading server actions.
 */

const FLAG = "on";

const PER_SYMBOL_EXIT_COOLDOWN_MS = 60 * 1000;
/** Max concurrent positions across the book. */
const MAX_OPEN_POSITIONS = 5;

export function AiExecutionEngine() {
  const router = useRouter();
  const decisions = useAiDecisionStore((s) => s.bySymbol);
  const lastExecutedAt = useAiDecisionStore((s) => s.lastExecutedAt);
  const lastExitAt = useAiDecisionStore((s) => s.lastExitAt);
  const markExecuted = useAiDecisionStore((s) => s.markExecuted);
  const markExited = useAiDecisionStore((s) => s.markExited);
  const appendLog = useAiDecisionStore((s) => s.appendLog);

  const positions = usePortfolioStore((s) => s.positions);
  const walletBalance = usePortfolioStore((s) => s.walletBalance);
  const usedMargin = usePortfolioStore((s) => s.usedMargin);
  // Sizing is done against *available* balance (cash that isn't already
  // locked as margin against open positions). Using the gross wallet here
  // would let the LLM repeatedly try to open positions it can't afford.
  const availableBalance = walletBalance - usedMargin;

  // Dedup: each decision (identified by its cache key) is acted on at most
  // once, even if multiple effects fire across re-renders. We track both
  // executed and rejected keys so we don't repeatedly toast the same gate.
  const seenDecisionKeys = useRef<Set<string>>(new Set());
  const inFlightSymbols = useRef<Set<string>>(new Set());

  // Snapshot store refs so async promise callbacks see fresh portfolio
  // values even if they resolve a few ticks after the effect fired.
  const stateRef = useRef({ positions, availableBalance, lastExecutedAt, lastExitAt });
  useEffect(() => {
    stateRef.current = { positions, availableBalance, lastExecutedAt, lastExitAt };
  }, [positions, availableBalance, lastExecutedAt, lastExitAt]);

  useEffect(() => {
    const autonomyOn = process.env.NEXT_PUBLIC_AI_AUTONOMY === FLAG;

    for (const symbol of Object.keys(decisions)) {
      const entry = decisions[symbol];
      if (!entry) continue;
      if (seenDecisionKeys.current.has(entry.key)) continue;
      seenDecisionKeys.current.add(entry.key);

      const { positions: pos, availableBalance: avail } = stateRef.current;
      const livePrice = useMarketStore.getState().tickers[symbol]?.last;
      if (livePrice == null || !Number.isFinite(livePrice) || livePrice <= 0) {
        continue;
      }

      // Any open position on this symbol — from any source — blocks a new
      // entry. The user's rule: never two trades on the same coin.
      const anyOpenOnSymbol = pos.find(
        (p) =>
          p.symbol === symbol &&
          (p.status === "OPEN" || p.status === "PARTIALLY_CLOSED"),
      );
      const llmOwnedPosition =
        anyOpenOnSymbol?.decisionSource === "LLM" ? anyOpenOnSymbol : undefined;

      // 1) Exit path — only the LLM may flip-close its own position. We never
      // auto-close a position owned by the rule engine or a manual entry.
      if (llmOwnedPosition) {
        const exitReason = evaluateExit(symbol, llmOwnedPosition, entry);
        if (exitReason) {
          if (autonomyOn) {
            fireExit(symbol, llmOwnedPosition, entry, livePrice, exitReason);
          }
          continue;
        }
      }

      // 2) Entry path — block if ANY position is already open on this symbol.
      if (anyOpenOnSymbol) {
        console.info(
          `[RISK] ${symbol} skipped — already have ${anyOpenOnSymbol.decisionSource} ${anyOpenOnSymbol.side} open`,
        );
        continue;
      }

      const side = decisionSide(entry.decision.decision);
      if (!side) {
        // Non-directional decision — assessor will flag it, but we skip the
        // proposal build because TradeProposal needs a side.
        const fakeAssessment: TradeAssessment = {
          approved: false,
          rejections: [
            {
              code: "no_trade_decision",
              message: `Decision is ${entry.decision.decision}`,
            },
          ],
          warnings: [],
          metrics: {
            expectedProfitPercent: 0,
            expectedLossPercent: 0,
            riskRewardRatio: 0,
            entryDriftBps: 0,
            volatilityScore: 0,
          },
          score: { value: 0, grade: "D", factors: [] },
          llmSetupQuality: entry.decision.setupQuality,
        };
        logRejection(entry, symbol, fakeAssessment);
        continue;
      }

      const proposal = buildProposal(symbol, side, entry, livePrice, pos, avail);
      const assessment = assessTradeQuality(proposal);

      if (!assessment.approved) {
        logRejection(entry, symbol, assessment);
        console.warn(
          `[RISK] ${symbol} ${entry.decision.decision} rejected (${assessment.rejections.length}): ${assessment.rejections.map((r) => r.code).join(", ")}`,
        );
        if (autonomyOn) {
          toast.info(
            `AI rejected ${symbol.replace("USDT", "")} — ${assessment.rejections[0]?.message ?? "validation failed"}`,
          );
        }
        continue;
      }

      // Approved. Fire the order (if autonomy is live).
      if (autonomyOn) {
        fireEntry(symbol, side, entry, assessment, livePrice, avail, proposal.marketRegime, pos);
      } else {
        logExecution(entry, symbol, assessment, undefined, "shadow", proposal.marketRegime);
      }
    }

    function buildProposal(
      symbol: string,
      side: "LONG" | "SHORT",
      entry: DecisionEntry,
      livePrice: number,
      pos: PaperPositionView[],
      availableBalance: number,
    ): TradeProposal {
      const openCount = pos.filter(
        (p) => p.status === "OPEN" || p.status === "PARTIALLY_CLOSED",
      ).length;
      const hasDupSide = pos.some(
        (p) =>
          p.symbol === symbol &&
          p.side === side &&
          (p.status === "OPEN" || p.status === "PARTIALLY_CLOSED"),
      );
      const lastExec = useAiDecisionStore.getState().lastExecutedAt[symbol];
      const msSinceLast = lastExec ? Date.now() - lastExec : null;

      // ATR% from the candle store for this symbol/interval. Best-effort —
      // the assessor tolerates `null` and skips volatility checks.
      const interval = useMarketStore.getState().interval;
      const candleKey = `${symbol}:${interval}`;
      const candles = useMarketStore.getState().candles[candleKey];
      const last = candles?.at(-1);
      const atrPct =
        last && last.close > 0 && "atrPct" in last
          ? (last as { atrPct?: number }).atrPct ?? null
          : null;

      const indicators = calculateIndicators(candles ?? []);
      const marketRegime = indicators.regime ?? "Sideways";

      return {
        symbol,
        side,
        decision: entry.decision,
        livePrice,
        atrPct,
        marketRegime,
        book: {
          openPositionsCount: openCount,
          hasDuplicateSide: hasDupSide,
          msSinceLastExecution: msSinceLast,
          availableBalance,
        },
      };
    }

    function fireEntry(
      symbol: string,
      side: "LONG" | "SHORT",
      entry: DecisionEntry,
      assessment: TradeAssessment,
      livePrice: number,
      bal: number,
      marketRegime: string,
      pos: PaperPositionView[],
    ) {
      const d = entry.decision;
      const totalEquity = computeTotalEquity(pos, bal, walletBalance);
      const { totalOpenNotional, perSymbolOpenNotional, openPositionsCount } =
        computeExposure(pos, symbol);
      // ATR snapshot for the volatility multiplier — best-effort, same source
      // as the proposal.
      const interval = useMarketStore.getState().interval;
      const candles =
        useMarketStore.getState().candles[`${symbol}:${interval}`];
      const last = candles?.at(-1);
      const atrPct =
        last && last.close > 0 && "atrPct" in last
          ? (last as { atrPct?: number }).atrPct ?? null
          : null;

      const sizing = computeRiskAdjustedSize({
        symbol,
        side,
        livePrice,
        stopLossPrice: d.stopLoss,
        takeProfitPrice: d.takeProfit,
        totalEquity,
        availableBalance: bal,
        confidence: d.confidence,
        setupQuality: d.setupQuality,
        marketRegime,
        atrPct,
        decisionType: d.decision,
        exposure: {
          totalOpenNotional,
          perSymbolOpenNotional,
          openPositionsCount,
        },
        maxOpenPositions: MAX_OPEN_POSITIONS,
      });

      if (sizing.rejection) {
        console.warn(
          `[RISK] ${symbol} sized-out (${sizing.rejection}) — ${sizing.rationale}`,
        );
        toast.info(
          `AI passed on ${symbol.replace("USDT", "")} — ${sizing.rationale}`,
        );
        return;
      }
      const quantity = sizing.quantity;
      if (inFlightSymbols.current.has(symbol)) return;
      inFlightSymbols.current.add(symbol);
      markExecuted(symbol);

      const meta = JSON.stringify({
        model: entry.model,
        decision: d.decision,
        confidence: d.confidence,
        setupQuality: d.setupQuality,
        riskLevel: d.riskLevel,
        expectedHoldMins: d.expectedHoldTimeMinutes,
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
        quality: {
          score: assessment.score.value,
          grade: assessment.score.grade,
          regime: marketRegime,
        },
      });

      console.info(
        `[EXECUTION] firing ${d.decision} ${symbol} qty=${quantity} notional=${sizing.notional.toFixed(2)} px≈${livePrice.toFixed(2)} risk=$${sizing.riskAmount.toFixed(0)} (${sizing.riskPercent.toFixed(2)}%) target=+$${sizing.expectedProfit.toFixed(0)} loss=-$${sizing.expectedLoss.toFixed(0)} RR=${sizing.riskRewardRatio.toFixed(2)} eq=${sizing.equityPercent.toFixed(1)}%`,
      );
      console.info(`[EXECUTION] rationale → ${sizing.rationale}`);
      createPaperOrder({
        symbol,
        side,
        type: "MARKET",
        quantity,
        takeProfit: d.takeProfit,
        stopLoss: d.stopLoss,
        decisionSource: "LLM",
        decisionMeta: meta,
        blockIfAlreadyOpen: true,
      })
        .then((res) => {
          logExecution(entry, symbol, assessment, res.id, "executed");
          console.info(`[EXECUTION] order filled id=${res.id} symbol=${symbol}`);
          toast.success(
            `AI ${d.decision} ${symbol.replace("USDT", "")} · ${assessment.score.grade} (${assessment.score.value.toFixed(0)}) · RR ${assessment.metrics.riskRewardRatio.toFixed(2)}`,
          );
          router.refresh();
        })
        .catch((err) => {
          logExecution(
            entry,
            symbol,
            assessment,
            undefined,
            "rejected",
            err instanceof Error ? err.message : "Server error",
          );
          console.error(
            `[EXECUTION] order failed ${symbol}:`,
            err instanceof Error ? err.message : err,
          );
          toast.error(`AI order failed: ${symbol}`);
        })
        .finally(() => {
          inFlightSymbols.current.delete(symbol);
        });
    }

    function fireExit(
      symbol: string,
      position: PaperPositionView,
      entry: DecisionEntry,
      livePrice: number,
      reasonLabel: string,
    ) {
      const exitKey = `exit:${symbol}`;
      if (inFlightSymbols.current.has(exitKey)) return;
      inFlightSymbols.current.add(exitKey);
      markExited(symbol);

      console.info(
        `[EXIT] AI flip-close ${symbol} ${position.side} pos=${position.id} reason="${reasonLabel}"`,
      );
      closePaperPosition(position.id, livePrice, { reason: "AI_EXIT" })
        .then(() => {
          appendLog({
            id: `${entry.key}:exit`,
            symbol,
            at: Date.now(),
            decision: entry.decision.decision,
            setupQuality: entry.decision.setupQuality,
            confidence: entry.decision.confidence,
            outcome: "executed",
            headline: `Exit: ${reasonLabel}`,
          });
          toast(
            `AI closed ${symbol.replace("USDT", "")} — ${reasonLabel}`,
            { description: entry.decision.reasoning[0] },
          );
          router.refresh();
        })
        .catch((err) => {
          console.error(
            `[EXIT] close failed ${symbol}:`,
            err instanceof Error ? err.message : err,
          );
          toast.error(
            `AI exit failed: ${symbol} — ${err instanceof Error ? err.message : "server error"}`,
          );
        })
        .finally(() => {
          inFlightSymbols.current.delete(exitKey);
        });
    }

    function logRejection(
      entry: DecisionEntry,
      symbol: string,
      assessment: TradeAssessment,
    ) {
      const first = assessment.rejections[0];
      appendLog({
        id: `${entry.key}:rejected`,
        symbol,
        at: Date.now(),
        decision: entry.decision.decision,
        setupQuality: entry.decision.setupQuality,
        confidence: entry.decision.confidence,
        outcome: "rejected",
        rejectionReason: first?.message,
        rejections: assessment.rejections.map(({ code, message }) => ({ code, message })),
        headline: entry.decision.reasoning[0] ?? "",
        quality: {
          qualityScore: assessment.score.value,
          grade: assessment.score.grade,
          expectedProfitPercent: assessment.metrics.expectedProfitPercent,
          expectedLossPercent: assessment.metrics.expectedLossPercent,
          riskRewardRatio: assessment.metrics.riskRewardRatio,
          volatilityScore: assessment.metrics.volatilityScore,
          marketRegime: calculateIndicators(useMarketStore.getState().candles[`${symbol}:${useMarketStore.getState().interval}`] ?? []).regime ?? "Sideways",
        },
      });
    }

    function logExecution(
      entry: DecisionEntry,
      symbol: string,
      assessment: TradeAssessment,
      orderId: string | undefined,
      tag: "executed" | "shadow" | "rejected",
      errorMessage?: string,
    ) {
      appendLog({
        id: `${entry.key}:${tag}`,
        symbol,
        at: Date.now(),
        decision: entry.decision.decision,
        setupQuality: entry.decision.setupQuality,
        confidence: entry.decision.confidence,
        outcome: tag === "rejected" ? "rejected" : "executed",
        rejectionReason: errorMessage,
        orderId,
        headline:
          tag === "shadow"
            ? `Shadow approval (autonomy off) · ${entry.decision.reasoning[0] ?? ""}`
            : entry.decision.reasoning[0] ?? "",
        quality: {
          qualityScore: assessment.score.value,
          grade: assessment.score.grade,
          expectedProfitPercent: assessment.metrics.expectedProfitPercent,
          expectedLossPercent: assessment.metrics.expectedLossPercent,
          riskRewardRatio: assessment.metrics.riskRewardRatio,
          volatilityScore: assessment.metrics.volatilityScore,
          marketRegime: calculateIndicators(useMarketStore.getState().candles[`${symbol}:${useMarketStore.getState().interval}`] ?? []).regime ?? "Sideways",
        },
      });
    }
  }, [decisions, positions, availableBalance, appendLog, markExecuted, markExited]);

  return null;
}

/**
 * Decide whether a fresh decision should close the currently-open LLM
 * position on this symbol. Returns null to leave it open, or a short reason
 * label that goes into the toast + execution log.
 *
 * Cooldown prevents thrash if the LLM oscillates near a boundary.
 */
function evaluateExit(
  symbol: string,
  position: PaperPositionView,
  entry: DecisionEntry,
): string | null {
  const d = entry.decision;
  const lastExit = useAiDecisionStore.getState().lastExitAt[symbol];
  if (lastExit && Date.now() - lastExit < PER_SYMBOL_EXIT_COOLDOWN_MS) return null;

  if (d.setupQuality === "Avoid") return "setup graded Avoid";
  if (d.decision === "AVOID" && d.confidence >= 65) {
    return `LLM flipped to AVOID @ ${d.confidence}%`;
  }
  const newSide = decisionSide(d.decision);
  if (newSide && newSide !== position.side && d.confidence >= 60) {
    return `LLM flipped ${position.side} → ${newSide}`;
  }
  if (d.decision === "HOLD" && d.confidence >= 75) {
    const ageMs = Date.now() - new Date(position.createdAt).getTime();
    if (ageMs > 30 * 60 * 1000) return "HOLD after held >30min";
  }
  return null;
}

/** totalEquity = walletBalance + Σ unrealizedPnl across open positions. */
function computeTotalEquity(
  positions: PaperPositionView[],
  availableBalance: number,
  walletBalance: number,
): number {
  // Prefer wallet+unrealized when wallet is known; fall back to available
  // for the rare case the caller has only that.
  if (walletBalance > 0) {
    const unrealized = positions.reduce(
      (s, p) => s + (p.unrealizedPnl ?? 0),
      0,
    );
    return walletBalance + unrealized;
  }
  return availableBalance;
}

function computeExposure(positions: PaperPositionView[], symbol: string) {
  let totalOpenNotional = 0;
  let perSymbolOpenNotional = 0;
  let openPositionsCount = 0;
  for (const p of positions) {
    if (p.status !== "OPEN" && p.status !== "PARTIALLY_CLOSED") continue;
    openPositionsCount += 1;
    const notional = p.quantity * p.entryPrice;
    totalOpenNotional += notional;
    if (p.symbol === symbol) perSymbolOpenNotional += notional;
  }
  return { totalOpenNotional, perSymbolOpenNotional, openPositionsCount };
}
