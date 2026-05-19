"use client";

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
        fillPaperOrder(order.id, fillPrice)
          .catch(() => {
            processingRef.current.delete(order.id);
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

      if (pos.takeProfit != null) {
        if (pos.side === "LONG" && currentPrice >= pos.takeProfit) reason = "TAKE_PROFIT";
        if (pos.side === "SHORT" && currentPrice <= pos.takeProfit) reason = "TAKE_PROFIT";
      }
      if (!reason && pos.stopLoss != null) {
        if (pos.side === "LONG" && currentPrice <= pos.stopLoss) reason = "STOP_LOSS";
        if (pos.side === "SHORT" && currentPrice >= pos.stopLoss) reason = "STOP_LOSS";
      }

      if (reason) {
        processingRef.current.add(key);
        console.info(
          `[matching-engine] ${reason} hit on ${pos.symbol} ${pos.side} @ ${currentPrice} (pos ${pos.id})`,
        );
        closePaperPosition(pos.id, currentPrice, { reason })
          .catch((err) => {
            processingRef.current.delete(key);
            console.error(
              `[matching-engine] close failed for ${pos.id}:`,
              err instanceof Error ? err.message : err,
            );
          });
      }
    }
  }, [tickers, pendingOrders, openPositions]);
}
