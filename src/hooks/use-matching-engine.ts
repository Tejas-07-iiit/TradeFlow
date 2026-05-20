"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { cancelPaperOrder, closePaperPosition, fillPaperOrder } from "@/server/trading";
import { useMarketStore } from "@/store/market-store";
import type { PaperOrderView, PaperPositionView } from "@/types/portfolio";

/**
 * Client-side paper matching engine.
 *
 * - Fills MARKET orders immediately at the current tick.
 * - Fills LIMIT orders when price crosses the limit (LONG: tick ≤ limit,
 *   SHORT: tick ≥ limit) — filled at the limit, not the tick, so we don't
 *   simulate getting a better fill than the user asked for.
 * - Expires PENDING orders past their `expiresAt`.
 * - Auto-closes positions when mark hits TP/SL, tagging the close reason so
 *   TradeHistory can distinguish manual vs risk-control exits.
 *
 * Idempotency: the in-memory `processingRef` is a soft optimisation only.
 * The hard guarantee that a position settles ONCE and an order fills ONCE
 * lives in the server actions, which use conditional `updateMany` CAS on
 * (id, status) — any losing race no-ops cleanly with `count===0`.
 */
export function useMatchingEngine(
  pendingOrders: PaperOrderView[],
  openPositions: PaperPositionView[],
) {
  const router = useRouter();
  const tickers = useMarketStore((state) => state.tickers);
  const processingRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const now = Date.now();

    for (const order of pendingOrders) {
      if (processingRef.current.has(order.id)) continue;

      if (order.expiresAt && new Date(order.expiresAt).getTime() <= now) {
        processingRef.current.add(order.id);
        cancelPaperOrder(order.id, "EXPIRED")
          .catch(() => {
            processingRef.current.delete(order.id);
          });
        continue;
      }

      const ticker = tickers[order.symbol];
      if (!ticker) continue;

      const currentPrice = ticker.last;
      let shouldFill = false;
      let fillPrice = currentPrice;

      if (order.orderType === "MARKET") {
        shouldFill = true;
      } else if (order.orderType === "LIMIT" && order.price != null) {
        const limitPrice = Number(order.price);
        if (order.side === "LONG" && currentPrice <= limitPrice) {
          shouldFill = true;
          fillPrice = limitPrice;
        } else if (order.side === "SHORT" && currentPrice >= limitPrice) {
          shouldFill = true;
          fillPrice = limitPrice;
        }
      }

      if (shouldFill) {
        processingRef.current.add(order.id);
        console.info(
          `[EXECUTION] filling ${order.orderType} ${order.side} ${order.symbol} @ ${fillPrice} (order ${order.id})`,
        );
        fillPaperOrder(order.id, fillPrice)
          .then(() => {
            router.refresh();
          })
          .catch((err) => {
            processingRef.current.delete(order.id);
            console.error(
              `[EXECUTION] fill failed for ${order.id}:`,
              err instanceof Error ? err.message : err,
            );
          });
      }
    }

    for (const pos of openPositions) {
      const key = `close-${pos.id}`;
      if (processingRef.current.has(key)) continue;

      const ticker = tickers[pos.symbol];
      if (!ticker) continue;

      const currentPrice = ticker.last;
      let reason: "TAKE_PROFIT" | "STOP_LOSS" | null = null;
      let exitPrice = currentPrice;
      let closedAt: number | undefined = undefined;

      // 1. Backfill check: Did we hit SL/TP while the system was offline?
      // We scan candles from the open time onwards. We prioritize SL over TP
      // to be conservative if a single massive candle engulfed both.
      const state = useMarketStore.getState();
      const symbolCandles = state.candles[`${pos.symbol}:${state.interval}`];
      
      if (symbolCandles) {
        const openedTime = Math.floor(new Date(pos.createdAt).getTime() / 1000);
        for (const c of symbolCandles) {
          if (c.time < openedTime) continue; // Candle happened before trade opened
          
          if (pos.stopLoss != null) {
            if (pos.side === "LONG" && c.low <= pos.stopLoss) {
              reason = "STOP_LOSS";
              exitPrice = pos.stopLoss;
              closedAt = c.time * 1000;
              break;
            }
            if (pos.side === "SHORT" && c.high >= pos.stopLoss) {
              reason = "STOP_LOSS";
              exitPrice = pos.stopLoss;
              closedAt = c.time * 1000;
              break;
            }
          }
          if (pos.takeProfit != null) {
            if (pos.side === "LONG" && c.high >= pos.takeProfit) {
              reason = "TAKE_PROFIT";
              exitPrice = pos.takeProfit;
              closedAt = c.time * 1000;
              break;
            }
            if (pos.side === "SHORT" && c.low <= pos.takeProfit) {
              reason = "TAKE_PROFIT";
              exitPrice = pos.takeProfit;
              closedAt = c.time * 1000;
              break;
            }
          }
        }
      }

      // 2. Live Check: If history didn't trigger it, check the current live price
      if (!reason) {
        if (pos.stopLoss != null) {
          if (pos.side === "LONG" && currentPrice <= pos.stopLoss) reason = "STOP_LOSS";
          if (pos.side === "SHORT" && currentPrice >= pos.stopLoss) reason = "STOP_LOSS";
          if (reason) exitPrice = pos.stopLoss;
        }
        if (!reason && pos.takeProfit != null) {
          if (pos.side === "LONG" && currentPrice >= pos.takeProfit) reason = "TAKE_PROFIT";
          if (pos.side === "SHORT" && currentPrice <= pos.takeProfit) reason = "TAKE_PROFIT";
          if (reason) exitPrice = pos.takeProfit;
        }
      }

      if (reason) {
        processingRef.current.add(key);
        console.info(
          `[EXIT] ${reason} hit on ${pos.symbol} ${pos.side} @ ${exitPrice} (pos ${pos.id})`,
        );
        closePaperPosition(pos.id, exitPrice, { reason, closedAt })
          .then(() => {
            router.refresh();
          })
          .catch((err) => {
            processingRef.current.delete(key);
            console.error(
              `[EXIT] close failed for ${pos.id}:`,
              err instanceof Error ? err.message : err,
            );
          });
      }
    }
  }, [tickers, pendingOrders, openPositions, router]);
}
