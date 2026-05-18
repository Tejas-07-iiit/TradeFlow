"use client";

import { useEffect, useRef } from "react";
import { DecisionPanel } from "@/features/ai-decision/decision-panel";
import { generateDecision } from "@/lib/signals/signal-engine";
import { EMPTY_ARRAY, useMarketStore } from "@/store/market-store";
import { useSignalStore } from "@/store/signal-store";

export function LiveDecisionPanel() {
  const symbol = useMarketStore((state) => state.symbol);
  const interval = useMarketStore((state) => state.interval);
  const candles = useMarketStore((state) => state.candles);
  const addSignal = useSignalStore((state) => state.addSignal);
  const checkExpirations = useSignalStore((state) => state.checkExpirations);

  const decision = generateDecision(symbol, candles, interval);

  // Check expirations every 30 seconds
  useEffect(() => {
    const timer = setInterval(() => {
      checkExpirations();
    }, 30000);
    return () => clearInterval(timer);
  }, [checkExpirations]);

  useEffect(() => {
    if (decision.signal !== "HOLD") {
      addSignal(decision);
    }
  }, [decision, addSignal]);

  return <DecisionPanel decision={decision} />;
}
