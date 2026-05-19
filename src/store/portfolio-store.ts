"use client";

import { create } from "zustand";
import type {
  PaperOrderView,
  PaperPositionView,
  TradeHistoryView,
} from "@/types/portfolio";

/**
 * Client-side mirror of the user's paper account. The five accounting fields
 * are kept STRICTLY SEPARATE — the UI must never collapse them into a single
 * "balance" number, or it re-introduces the bug class we just removed.
 *
 *   walletBalance — cleared cash on the wallet row.
 *   usedMargin    — collateral locked against open positions.
 *   Derived in the UI from positions × live ticker:
 *     unrealizedPnl  — Σ (side==LONG?+1:-1) * (mark − entry) * qty
 *     totalEquity    — walletBalance + unrealizedPnl
 *     availableBal   — walletBalance − usedMargin
 *   realizedPnl   — running total on closed slices (history-derived).
 */
interface PortfolioState {
  walletBalance: number;
  usedMargin: number;
  currency: string;
  positions: PaperPositionView[];
  orders: PaperOrderView[];
  tradeHistory: TradeHistoryView[];

  setPortfolio: (data: {
    walletBalance: number;
    usedMargin: number;
    currency: string;
    positions: PaperPositionView[];
    orders: PaperOrderView[];
    tradeHistory: TradeHistoryView[];
  }) => void;
}

export const usePortfolioStore = create<PortfolioState>((set) => ({
  walletBalance: 0,
  usedMargin: 0,
  currency: "USDT",
  positions: [],
  orders: [],
  tradeHistory: [],

  setPortfolio: (data) => set(data),
}));
