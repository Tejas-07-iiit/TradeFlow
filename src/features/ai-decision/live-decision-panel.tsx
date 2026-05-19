"use client";

import { DecisionPanel } from "@/features/ai-decision/decision-panel";
import { generateDecision } from "@/lib/signals/signal-engine";
import { useMarketStore } from "@/store/market-store";
import { useAiDecisionStore } from "@/store/ai-decision-store";
import { decisionSide } from "@/services/ai/schemas";
import type { AIDecision, SignalType } from "@/types/ai-decision";

export function LiveDecisionPanel() {
  const symbol = useMarketStore((state) => state.symbol);
  const interval = useMarketStore((state) => state.interval);
  const candles = useMarketStore((state) => state.candles);

  // 1. Get the base mathematical signal
  const mathDecision = generateDecision(symbol, candles, interval);

  // 2. Get the LLM decision
  const llmEntry = useAiDecisionStore((state) => state.bySymbol[symbol]);

  // 3. Merge them so the UI reflects the true active AI decision
  const decision: AIDecision = { ...mathDecision };

  if (llmEntry) {
    const d = llmEntry.decision;
    decision.confidence = d.confidence;
    decision.setupQuality = (d.setupQuality === "B+" ? "B" : d.setupQuality === "Avoid" ? "C" : d.setupQuality) as any;
    decision.risk = d.riskLevel;
    
    if (d.decision === "AVOID" || d.decision === "HOLD") {
      decision.signal = "HOLD";
      decision.type = "NONE";
    } else {
      const side = decisionSide(d.decision);
      decision.signal = side === "LONG" ? "BUY" : "SELL";
      // The LLM decision explicitly outputs "BREAKOUT LONG" etc., which perfectly matches SignalType
      decision.type = d.decision as SignalType;
    }
    
    decision.entryPrice = d.entryPrice;
    decision.takeProfit = d.takeProfit;
    decision.stopLoss = d.stopLoss;
    
    if (d.takeProfit && d.stopLoss && d.entryPrice && d.entryPrice !== d.stopLoss) {
      const reward = Math.abs(d.takeProfit - d.entryPrice);
      const risk = Math.abs(d.entryPrice - d.stopLoss);
      decision.rrRatio = risk > 0 ? reward / risk : undefined;
    }
    
    decision.expectedHoldTime = `${d.expectedHoldTimeMinutes} mins`;
    decision.reasons = d.reasoning;
    decision.warnings = d.warnings;
    decision.verdict = d.marketSummary;
  }

  return <DecisionPanel decision={decision} />;
}
