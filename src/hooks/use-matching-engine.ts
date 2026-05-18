"use client";

import { useEffect, useRef } from "react";
import { fillPaperOrder, closePaperPosition } from "@/server/trading";
import { useMarketStore } from "@/store/market-store";
import type { PaperOrderView, PaperPositionView } from "@/types/portfolio";

/**
 * A client-side matching engine that simulates order execution.
 * It monitors live prices and triggers server actions when targets are hit.
 */
export function useMatchingEngine(
  pendingOrders: PaperOrderView[],
  openPositions: PaperPositionView[],
) {
  const tickers = useMarketStore((state) => state.tickers);
  const processingRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    // 1. Process Pending Orders
    if (pendingOrders.length > 0) {
      for (const order of pendingOrders) {
        if (processingRef.current.has(order.id)) continue;

        const ticker = tickers[order.symbol];
        if (!ticker) continue;

        const currentPrice = ticker.last;
        let shouldFill = false;
        let fillPrice = currentPrice;

        if (order.orderType === "MARKET") {
          shouldFill = true;
        } else if (order.orderType === "LIMIT") {
          const limitPrice = Number(order.price);
          if (order.side === "LONG") {
            if (currentPrice <= limitPrice) {
              shouldFill = true;
              fillPrice = limitPrice;
            }
          } else {
            if (currentPrice >= limitPrice) {
              shouldFill = true;
              fillPrice = limitPrice;
            }
          }
        }

        if (shouldFill) {
          processingRef.current.add(order.id);
          fillPaperOrder(order.id, fillPrice).catch(() => {
            processingRef.current.delete(order.id);
          });
        }
      }
    }

    // 2. Process Open Position TP/SL
    if (openPositions.length > 0) {
      for (const pos of openPositions) {
        if (processingRef.current.has(`close-${pos.id}`)) continue;

        const ticker = tickers[pos.symbol];
        if (!ticker) continue;

        const currentPrice = ticker.last;
        let shouldClose = false;

        // Take Profit logic
        if (pos.takeProfit) {
          if (pos.side === "LONG" && currentPrice >= pos.takeProfit) shouldClose = true;
          if (pos.side === "SHORT" && currentPrice <= pos.takeProfit) shouldClose = true;
        }

        // Stop Loss logic
        if (!shouldClose && pos.stopLoss) {
          if (pos.side === "LONG" && currentPrice <= pos.stopLoss) shouldClose = true;
          if (pos.side === "SHORT" && currentPrice >= pos.stopLoss) shouldClose = true;
        }

        if (shouldClose) {
          processingRef.current.add(`close-${pos.id}`);
          closePaperPosition(pos.id, currentPrice).catch(() => {
            processingRef.current.delete(`close-${pos.id}`);
          });
        }
      }
    }
  }, [tickers, pendingOrders, openPositions]);
}
