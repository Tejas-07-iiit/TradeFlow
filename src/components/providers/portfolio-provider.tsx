"use client";

import { useEffect } from "react";
import { usePortfolioStore } from "@/store/portfolio-store";
import type { PaperOrderView, PaperPositionView } from "@/types/portfolio";

export function PortfolioProvider({
  balance,
  currency,
  positions,
  orders,
  children,
}: {
  balance: number;
  currency: string;
  positions: PaperPositionView[];
  orders: PaperOrderView[];
  children: React.ReactNode;
}) {
  const setPortfolio = usePortfolioStore((s) => s.setPortfolio);

  useEffect(() => {
    setPortfolio({ balance, currency, positions, orders });
  }, [balance, currency, positions, orders, setPortfolio]);

  return children;
}
