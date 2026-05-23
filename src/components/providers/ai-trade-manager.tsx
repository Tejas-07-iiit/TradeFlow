"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { toast } from "sonner";

import { useMarketStore } from "@/store/market-store";
import { usePortfolioStore } from "@/store/portfolio-store";
import { useAiDecisionStore } from "@/store/ai-decision-store";
import { calculateIndicators } from "@/lib/signals/signal-engine";
import { computePositionRiskMetrics } from "@/lib/risk/metrics";
import { runCandlestickEngine } from "@/lib/candlestick";
import { macd } from "@/lib/indicators/calculations";
import { evaluatePosition } from "@/services/trade-manager";
import {
  closePaperPosition,
  updatePositionLevels,
  updatePositionHealthScore,
  createManagementEvent,
} from "@/server/trading";
import type {
  ManagedPositionContext,
  ManagementIndicators,
} from "@/types/trade-management";

const EVAL_INTERVAL_MS = 30_000;
const AUTONOMY_FLAG = "on";

export function AiTradeManager() {
  const router = useRouter();
  const positions = usePortfolioStore((s) => s.positions);
  const inFlightPositions = useRef<Set<string>>(new Set());

  // Use a ref to access the fresh list of positions inside the interval callback
  const positionsRef = useRef(positions);
  useEffect(() => {
    positionsRef.current = positions;
  }, [positions]);

  useEffect(() => {
    const autonomyOn = process.env.NEXT_PUBLIC_AI_AUTONOMY === AUTONOMY_FLAG;

    const runManagementLoop = async () => {
      // Find open positions that are owned by the LLM
      const openLlmPositions = positionsRef.current.filter(
        (p) =>
          p.decisionSource === "LLM" &&
          (p.status === "OPEN" || p.status === "PARTIALLY_CLOSED")
      );

      if (openLlmPositions.length === 0) return;

      const interval = useMarketStore.getState().interval;

      for (const pos of openLlmPositions) {
        const symbol = pos.symbol;

        // Skip if this position has an operation in-flight
        if (inFlightPositions.current.has(pos.id)) {
          continue;
        }

        const candleKey = `${symbol}:${interval}`;
        const candles = useMarketStore.getState().candles[candleKey];

        // Skip if we don't have sufficient candles to calculate indicators
        if (!candles || candles.length < 20) {
          continue;
        }

        const livePrice = useMarketStore.getState().tickers[symbol]?.last;
        if (livePrice == null || !Number.isFinite(livePrice) || livePrice <= 0) {
          continue;
        }

        try {
          inFlightPositions.current.add(pos.id);

          // 1. Calculate technical indicators
          const technicals = calculateIndicators(candles);
          
          // Calculate MACD series to extract current and previous values
          const closes = candles.map((c) => c.close);
          const macdSeries = macd(closes);
          const macdVal = macdSeries.at(-1) ?? null;
          const macdPrev = macdSeries.length >= 2 ? macdSeries.at(-2) ?? null : null;

          // Compute volume averages
          const volume = candles.at(-1)?.volume ?? 0;
          const avgVolume = candles.slice(-20).reduce((sum, c) => sum + c.volume, 0) / Math.min(20, candles.length);

          // 2. Run candlestick engine
          const candleIntel = runCandlestickEngine({
            symbol,
            timeframe: interval as any,
            candles,
            minConfidence: 50,
          });
          const candlestickBias = candleIntel.netBias;
          const candlestickCategory = candleIntel.dominantCategory;

          // 3. Get News sentiment validation
          const newsValidation = useAiDecisionStore.getState().bySymbol[symbol]?.newsValidation;
          const newsClass = newsValidation?.aggregateClass ?? null;
          const newsScore = newsValidation?.score ?? null;

          // ─── Compile Indicators ───
          const mIndicators: ManagementIndicators = {
            ema50: technicals.ema50,
            ema200: technicals.ema200,
            rsi14: technicals.rsi14,
            macd: macdVal,
            macdPrev: macdPrev,
            atr14: technicals.atr14,
            atrPct: technicals.atrPct,
            adx14: technicals.adx14,
            vwap: technicals.vwap,
            vwapSlope: technicals.vwapSlope,
            regime: technicals.regime,
            bb: technicals.bb,
            volume,
            avgVolume,
            candlestickBias,
            candlestickCategory,
            newsClass,
            newsScore,
          };

          // ─── Compile Position Context ───
          const qty = Number(pos.quantity);
          const entry = Number(pos.entryPrice);
          const riskMetrics = computePositionRiskMetrics({
            side: pos.side,
            entryPrice: entry,
            quantity: qty,
            leverage: pos.leverage,
            takeProfitPrice: pos.takeProfit ? Number(pos.takeProfit) : null,
            stopLossPrice: pos.stopLoss ? Number(pos.stopLoss) : null,
            currentPrice: livePrice,
          });
          const unrealizedPnl = riskMetrics.unrealizedPnl;
          const unrealizedPnlPct = riskMetrics.unrealizedPnlPct;

          // Parse pos.decisionMeta to extract setupQuality and qualityScore
          let setupQuality: string | undefined = undefined;
          let qualityScore: number | undefined = undefined;
          if (pos.decisionMeta) {
            try {
              const parsedMeta = JSON.parse(pos.decisionMeta);
              setupQuality = parsedMeta.setupQuality;
              if (parsedMeta.quality && typeof parsedMeta.quality.score === "number") {
                qualityScore = parsedMeta.quality.score;
              }
            } catch (e) {
              console.warn(`Failed to parse decisionMeta for position ${pos.id}`, e);
            }
          }

          const context: ManagedPositionContext = {
            id: pos.id,
            symbol: pos.symbol,
            side: pos.side,
            entryPrice: entry,
            quantity: qty,
            initialQuantity: Number(pos.initialQuantity),
            takeProfit: pos.takeProfit ? Number(pos.takeProfit) : null,
            stopLoss: pos.stopLoss ? Number(pos.stopLoss) : null,
            originalTakeProfit: pos.originalTakeProfit ? Number(pos.originalTakeProfit) : null,
            originalStopLoss: pos.originalStopLoss ? Number(pos.originalStopLoss) : null,
            tradeHealthScore: pos.tradeHealthScore ?? null,
            managementMeta: pos.managementMeta as any,
            marginUsed: Number(pos.marginUsed),
            createdAt: new Date(pos.createdAt).toISOString(),
            livePrice,
            unrealizedPnl,
            unrealizedPnlPct,
            setupQuality,
            qualityScore,
          };

          // Extract closed candles
          const closedCandles = candles.slice(0, -1);

          // 4. Evaluate position actions
          const { action, updatedMeta } = evaluatePosition(context, mIndicators, closedCandles, interval);

          // ─── Execute Actions ───

          if (action.type === "HOLD") {
            // Regularly update health score in database to keep UI fresh
            await updatePositionHealthScore(pos.id, action.healthScore.overall, updatedMeta);
          } 
          else if (action.type === "EARLY_EXIT") {
            if (autonomyOn) {
              console.info(`[TRADE-MGMT] Triggering early exit for ${symbol} @ ${livePrice}. Reason: ${action.reason}`);
              const res = await closePaperPosition(pos.id, livePrice, {
                reason: "AI_EARLY_EXIT",
              });
              if (res) {
                await createManagementEvent({
                  positionId: pos.id,
                  type: "EARLY_EXIT",
                  oldValue: qty,
                  newValue: 0,
                  healthScore: action.healthScore.overall,
                  confidence: action.confidence,
                  reason: action.reason,
                  indicators: mIndicators,
                });
                toast.error(`[Trade Manager] Early Exit triggered for ${symbol}: ${action.reason}`);
                router.refresh();
              }
            } else {
              console.info(`[TRADE-MGMT] (Shadow mode) Early exit assessment for ${symbol}: ${action.reason}`);
              await updatePositionHealthScore(pos.id, action.healthScore.overall, updatedMeta);
            }
          } 
          else if (action.type === "PARTIAL_EXIT") {
            if (action.reason.includes("Confidence-based")) {
              updatedMeta.confidencePartialExitDone = true;
            }
            if (autonomyOn && action.quantity) {
              console.info(`[TRADE-MGMT] Triggering partial exit for ${symbol} closeQty=${action.quantity} @ ${livePrice}. Reason: ${action.reason}`);
              const res = await closePaperPosition(pos.id, livePrice, {
                quantity: action.quantity,
                reason: "MANUAL",
              });
              if (res) {
                // Update position meta and score immediately
                await updatePositionHealthScore(pos.id, action.healthScore.overall, updatedMeta);
                
                await createManagementEvent({
                  positionId: pos.id,
                  type: "PARTIAL_EXIT",
                  oldValue: qty,
                  newValue: qty - action.quantity,
                  healthScore: action.healthScore.overall,
                  confidence: action.confidence,
                  reason: action.reason,
                  indicators: mIndicators,
                });
                toast.warning(`[Trade Manager] Partial profit taken (50%) on ${symbol}: ${action.reason}`);
                router.refresh();
              }
            } else {
              console.info(`[TRADE-MGMT] (Shadow mode) Partial exit assessment for ${symbol}: ${action.reason}`);
              await updatePositionHealthScore(pos.id, action.healthScore.overall, updatedMeta);
            }
          } 
          else if (
            action.type === "ADJUST_TP" || 
            action.type === "ADJUST_SL" || 
            action.type === "TRAIL_SL" || 
            action.type === "BREAKEVEN_SL"
          ) {
            if (autonomyOn && action.newValue !== undefined) {
              const currentTP = pos.takeProfit ? Number(pos.takeProfit) : null;
              const currentSL = pos.stopLoss ? Number(pos.stopLoss) : null;

              const isTpUpdate = action.type === "ADJUST_TP";
              const nextTP = isTpUpdate ? action.newValue : currentTP;
              const nextSL = !isTpUpdate ? action.newValue : currentSL;

              console.info(`[TRADE-MGMT] Adjusting levels for ${symbol}: nextTP=${nextTP}, nextSL=${nextSL}. Reason: ${action.reason}`);
              
              const res = await updatePositionLevels(pos.id, {
                takeProfit: nextTP,
                stopLoss: nextSL,
                currentTakeProfit: currentTP,
                currentStopLoss: currentSL,
                managementMeta: updatedMeta,
                healthScore: action.healthScore.overall,
              });

              if (res?.ok) {
                let eventType = "SL_ADJUSTED";
                if (action.type === "ADJUST_TP") eventType = "TP_ADJUSTED";
                else if (action.type === "TRAIL_SL") eventType = "SL_TRAILED";
                else if (action.type === "BREAKEVEN_SL") eventType = "SL_BREAKEVEN";

                await createManagementEvent({
                  positionId: pos.id,
                  type: eventType,
                  oldValue: isTpUpdate ? currentTP : currentSL,
                  newValue: action.newValue,
                  healthScore: action.healthScore.overall,
                  confidence: action.confidence,
                  reason: action.reason,
                  indicators: mIndicators,
                });

                toast.info(`[Trade Manager] Adjusted ${isTpUpdate ? "Take Profit" : "Stop Loss"} for ${symbol}: ${action.reason}`);
                router.refresh();
              }
            } else {
              console.info(`[TRADE-MGMT] (Shadow mode) Adjust levels assessment for ${symbol} to ${action.newValue}: ${action.reason}`);
              await updatePositionHealthScore(pos.id, action.healthScore.overall, updatedMeta);
            }
          }
        } catch (err) {
          console.error(`[TRADE-MGMT] Failed to process management for position ${pos.id}:`, err);
        } finally {
          inFlightPositions.current.delete(pos.id);
        }
      }
    };

    // Run immediately on mount, then on interval
    void runManagementLoop();
    const intervalId = setInterval(runManagementLoop, EVAL_INTERVAL_MS);

    return () => {
      clearInterval(intervalId);
    };
  }, []);

  return null;
}
