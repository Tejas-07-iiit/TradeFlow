"use client";

import { useEffect } from "react";
import { usePortfolioStore } from "@/store/portfolio-store";
import type {
  PaperOrderView,
  PaperPositionView,
  TradeHistoryView,
} from "@/types/portfolio";

export function PortfolioProvider({
  walletBalance,
  usedMargin,
  currency,
  positions,
  orders,
  tradeHistory,
  children,
}: {
  walletBalance: number;
  usedMargin: number;
  currency: string;
  positions: PaperPositionView[];
  orders: PaperOrderView[];
  tradeHistory: TradeHistoryView[];
  children: React.ReactNode;
}) {
  const setPortfolio = usePortfolioStore((s) => s.setPortfolio);

  useEffect(() => {
    setPortfolio({
      walletBalance,
      usedMargin,
      currency,
      positions,
      orders,
      tradeHistory,
    });
  }, [
    walletBalance,
    usedMargin,
    currency,
    positions,
    orders,
    tradeHistory,
    setPortfolio,
  ]);

  return children;
}
