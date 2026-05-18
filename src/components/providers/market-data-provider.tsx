"use client";

import { useMarketData } from "@/hooks/use-market-data";
import { useMarketStore } from "@/store/market-store";

export function MarketDataProvider({ children }: { children: React.ReactNode }) {
  const interval = useMarketStore((state) => state.interval);
  useMarketData(interval);

  return children;
}
