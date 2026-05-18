"use client";

import { useMatchingEngine } from "@/hooks/use-matching-engine";
import { usePortfolioStore } from "@/store/portfolio-store";

export function MatchingEngineSubscriber() {
  const orders = usePortfolioStore((s) => s.orders);
  const positions = usePortfolioStore((s) => s.positions);
  
  const pendingOrders = orders.filter(o => o.status === "PENDING");
  const openPositions = positions.filter(p => p.status === "OPEN");

  useMatchingEngine(pendingOrders, openPositions);
  return null;
}
