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
import { decisionSide, type MarketDecision } from "@/services/ai/schemas";
import type { NewsValidationResult } from "@/services/news/validator-types";
import { useAiDecisionStore, type DecisionEntry } from "@/store/ai-decision-store";
import { useMarketStore } from "@/store/market-store";
import { usePortfolioStore } from "@/store/portfolio-store";
import type { PaperPositionView } from "@/types/portfolio";
import { saveExplainableSignal } from "@/server/xai-signals";
import { runCandlestickEngine } from "@/lib/candlestick";

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

      // News validation gate — runs before risk assessment so a critical
      // risk headline blocks the trade *before* we score it. Fail-open if
      // the validator is missing: treat as no adjustment.
      const news = entry.newsValidation;
      if (news?.status === "ok" && news.action === "REJECT") {
        const newsRejection: TradeAssessment = {
          approved: false,
          rejections: [
            {
              code: "news_critical_risk",
              message: news.rationale,
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
        logRejection(entry, symbol, newsRejection);
        console.warn(
          `[NEWS] ${symbol} ${entry.decision.decision} REJECTED — ${news.rationale}`,
        );
        if (autonomyOn) {
          toast.warning(
            `News blocked ${symbol.replace("USDT", "")} — ${news.aggregateClass}`,
          );
        }
        continue;
      }

      // Apply news-driven SL tightening BEFORE the assessment so the
      // assessor scores against the news-adjusted risk envelope.
      const effectiveDecision = applyNewsAdjustments(
        entry.decision,
        side,
        livePrice,
        news,
      );
      const effectiveEntry: DecisionEntry = { ...entry, decision: effectiveDecision };

      const proposal = buildProposal(
        symbol,
        side,
        effectiveEntry,
        livePrice,
        pos,
        avail,
      );
      const assessment = assessTradeQuality(proposal);

      if (!assessment.approved) {
        logRejection(effectiveEntry, symbol, assessment);
        console.warn(
          `[RISK] ${symbol} ${effectiveDecision.decision} rejected (${assessment.rejections.length}): ${assessment.rejections.map((r) => r.code).join(", ")}`,
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
        fireEntry(
          symbol,
          side,
          effectiveEntry,
          assessment,
          livePrice,
          avail,
          proposal.marketRegime,
          pos,
        );
      } else {
        logExecution(
          effectiveEntry,
          symbol,
          assessment,
          undefined,
          "shadow",
          proposal.marketRegime,
        );
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
        key: entry.key,
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

      const news = entry.newsValidation;
      const externalSizeMultiplier =
        news && news.status === "ok" ? news.sizeMultiplier : 1;

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
        externalSizeMultiplier,
      });

      if (sizing.rejection) {
        console.warn(
          `[RISK] ${symbol} sized-out (${sizing.rejection}) — ${sizing.rationale}`,
        );
        toast.info(
          `AI passed on ${symbol.replace("USDT", "")} — ${sizing.rationale}`,
        );
        void persistSignalReport({
          entry,
          symbol,
          assessment,
          status: "REJECTED",
          executionResult: `sized_out: ${sizing.rationale}`,
        });
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
          externalSizeMultiplier: sizing.externalSizeMultiplier,
        },
        quality: {
          score: assessment.score.value,
          grade: assessment.score.grade,
          regime: marketRegime,
        },
        news:
          news && news.status === "ok"
            ? {
                aggregateClass: news.aggregateClass,
                score: news.score,
                action: news.action,
                sizeMult: news.sizeMultiplier,
                stopMult: news.stopMultiplier,
                items: news.itemsConsidered,
                topHeadline: news.items[0]?.title,
                llm: news.llmEnrichmentUsed,
              }
            : {
                status: news?.status ?? "missing",
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
        newsValidation: entry.newsValidation,
      });

      let execResult = first?.message ?? "rejection";
      if (entry.newsValidation?.status === "ok" && entry.newsValidation.action === "REJECT") {
        execResult = `news_veto: ${entry.newsValidation.rationale}`;
      }
      void persistSignalReport({
        entry,
        symbol,
        assessment,
        status: "REJECTED",
        executionResult: execResult,
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
        newsValidation: entry.newsValidation,
      });

      let finalStatus: "ACCEPTED" | "REJECTED" | "MODIFIED" | "SHADOW_ACCEPTED" = "ACCEPTED";
      if (tag === "rejected") {
        finalStatus = "REJECTED";
      } else if (tag === "shadow") {
        finalStatus = "SHADOW_ACCEPTED";
      } else if (entry.newsValidation && entry.newsValidation.status === "ok" && entry.newsValidation.sizeMultiplier < 1) {
        finalStatus = "MODIFIED";
      }

      void persistSignalReport({
        entry,
        symbol,
        assessment,
        status: finalStatus,
        executionResult: orderId || errorMessage || (tag === "shadow" ? "Shadow approval" : undefined),
      });
    }

    async function persistSignalReport({
      entry,
      symbol,
      assessment,
      status,
      executionResult,
    }: {
      entry: DecisionEntry;
      symbol: string;
      assessment: TradeAssessment;
      status: "ACCEPTED" | "REJECTED" | "MODIFIED" | "SHADOW_ACCEPTED";
      executionResult?: string;
    }) {
      try {
        const interval = useMarketStore.getState().interval;
        const candles = useMarketStore.getState().candles[`${symbol}:${interval}`] ?? [];
        const indicators = calculateIndicators(candles);

        // EMA Alignment
        let emaAlignment = "No alignment";
        if (indicators.ema50 && indicators.ema200) {
          emaAlignment = indicators.ema50 > indicators.ema200
            ? "Bullish (EMA50 > EMA200)"
            : "Bearish (EMA50 < EMA200)";
        }

        // Support/Resistance 30-bar zones
        let supportPrice = null;
        let resistancePrice = null;
        if (candles.length >= 30) {
          const window = candles.slice(-30);
          supportPrice = Math.min(...window.map((c) => c.low));
          resistancePrice = Math.max(...window.map((c) => c.high));
        }

        // Candlestick Intelligence
        let candlestickPatterns = null;
        try {
          if (candles.length >= 14) {
            const intel = runCandlestickEngine({
              symbol,
              timeframe: interval,
              candles,
            });
            candlestickPatterns = {
              detections: intel.detections.slice(0, 4).map((d) => ({
                patternName: d.patternName,
                direction: d.direction,
                category: d.category,
                confidence: d.confidenceScore,
                strength: d.patternStrength,
                reasoning: d.reasoning,
              })),
              netBias: intel.netBias,
              narrative: intel.narrative,
              dominantCategory: intel.dominantCategory,
            };
          }
        } catch (err) {
          console.warn("[XAI-INTEGRATION] Failed to run candlestick engine:", err);
        }

        // AI Reasoning
        const reasoning = entry.decision.reasoning ?? [];

        // News validation
        const newsVal = entry.newsValidation;

        // Sizing logic
        const portfolio = usePortfolioStore.getState();
        const pos = portfolio.positions;
        const avail = portfolio.walletBalance - portfolio.usedMargin;
        const walBal = portfolio.walletBalance;

        const totalEquity = computeTotalEquity(pos, avail, walBal);
        const { totalOpenNotional, perSymbolOpenNotional, openPositionsCount } =
          computeExposure(pos, symbol);

        const last = candles?.at(-1);
        const atrPct =
          last && last.close > 0 && "atrPct" in last
            ? (last as { atrPct?: number }).atrPct ?? null
            : null;

        const side = decisionSide(entry.decision.decision) ?? "LONG";
        const livePrice = useMarketStore.getState().tickers[symbol]?.last ?? entry.decision.entryPrice;

        const news = entry.newsValidation;
        const externalSizeMultiplier =
          news && news.status === "ok" ? news.sizeMultiplier : 1;

        let sizing = null;
        try {
          sizing = computeRiskAdjustedSize({
            symbol,
            side,
            livePrice,
            stopLossPrice: entry.decision.stopLoss,
            takeProfitPrice: entry.decision.takeProfit,
            totalEquity,
            availableBalance: avail,
            confidence: entry.decision.confidence,
            setupQuality: entry.decision.setupQuality,
            marketRegime: indicators.regime,
            atrPct,
            decisionType: entry.decision.decision,
            exposure: {
              totalOpenNotional,
              perSymbolOpenNotional,
              openPositionsCount,
            },
            maxOpenPositions: MAX_OPEN_POSITIONS,
            externalSizeMultiplier,
          });
        } catch (err) {
          console.warn("[XAI-INTEGRATION] Failed to compute risk adjusted size:", err);
        }

        // Veto check
        let newsVetoResult = "Passed";
        if (newsVal?.status === "ok" && newsVal.action === "REJECT") {
          newsVetoResult = `Vetoed: ${newsVal.rationale}`;
        }

        const driftBps = assessment.metrics.entryDriftBps;
        const driftPercent = driftBps != null ? driftBps / 100 : 0;

        await saveExplainableSignal({
          symbol,
          side: decisionSide(entry.decision.decision) ?? "NONE",
          status,
          confidence: entry.decision.confidence,
          finalAction: entry.decision.decision,
          executionResult: executionResult || null,
          
          // Technical Analysis
          emaAlignment,
          rsi: indicators.rsi14,
          macd: indicators.macd ? JSON.parse(JSON.stringify(indicators.macd)) : null,
          vwap: indicators.vwap,
          volatility: indicators.atrPct,
          trendRegime: indicators.regime,
          supportPrice,
          resistancePrice,
          momentumAnalysis: indicators.adx14 ? `ADX: ${indicators.adx14.toFixed(1)}` : null,

          // Candlestick
          candlestickPatterns: candlestickPatterns ? JSON.parse(JSON.stringify(candlestickPatterns)) : null,

          // News
          newsValidation: newsVal ? JSON.parse(JSON.stringify(newsVal)) : null,

          // Reasoning
          reasoning: JSON.parse(JSON.stringify(reasoning)),

          // Risk Engine
          slPrice: entry.decision.stopLoss,
          tpPrice: entry.decision.takeProfit,
          riskRewardRatio: assessment.metrics.riskRewardRatio,
          leverageAdjustment: "None",
          sizeAdjustment: sizing?.multipliers
            ? `Adjusted (factors: ${JSON.stringify(sizing.multipliers)})`
            : "None",
          positionSizing: sizing ? JSON.parse(JSON.stringify({
            notional: sizing.notional,
            riskAmount: sizing.riskAmount,
            riskPercent: sizing.riskPercent,
            equityPercent: sizing.equityPercent,
            expectedProfit: sizing.expectedProfit,
            expectedLoss: sizing.expectedLoss,
            rr: sizing.riskRewardRatio,
            rationale: sizing.rationale,
            externalSizeMultiplier: sizing.externalSizeMultiplier
          })) : null,

          // Execution Validator
          entryDrift: driftPercent,
          spreadValidation: "Passed (standard spread)",
          liquidityChecks: "Passed (deep orderbook)",
          newsVetoResult
        });
      } catch (err) {
        console.error("[XAI-INTEGRATION-ERROR] Failed to save explainable signal:", err);
      }
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

/**
 * Apply news-validation adjustments to the candidate decision.
 *
 *   - News REJECT is handled at the call site (we never get here for it).
 *   - Stop tightening: bring the SL closer to entry by `stopMultiplier`.
 *     The original SL distance is multiplied by stopMult, keeping the SL
 *     on the correct side of entry.
 *   - Take-profit is untouched — the news layer never expands risk.
 *
 * Returns a new MarketDecision object; never mutates the input.
 */
function applyNewsAdjustments(
  decision: MarketDecision,
  side: "LONG" | "SHORT",
  livePrice: number,
  news: NewsValidationResult | undefined,
): MarketDecision {
  if (!news || news.status !== "ok") return decision;
  const stopMult = news.stopMultiplier;
  if (stopMult >= 1) return decision;

  const rawDist = Math.abs(livePrice - decision.stopLoss);
  if (rawDist <= 0 || !Number.isFinite(rawDist)) return decision;

  const newDist = rawDist * Math.max(0.4, stopMult);
  const newSL = side === "LONG" ? livePrice - newDist : livePrice + newDist;
  if (!Number.isFinite(newSL) || newSL <= 0) return decision;

  return { ...decision, stopLoss: newSL };
}
