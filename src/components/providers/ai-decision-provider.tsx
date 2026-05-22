"use client";

import { useEffect } from "react";
import { useAiDecisionStore } from "@/store/ai-decision-store";
import { getRecentExecutionLogs } from "@/server/xai-signals";
import type { ExecutionLogEntry, DecisionEntry } from "@/store/ai-decision-store";
import type { MarketDecision } from "@/services/ai/schemas";

function mapSignalToLogEntry(signal: any): ExecutionLogEntry {
  const positionSizing = signal.positionSizing
    ? (typeof signal.positionSizing === "string"
        ? JSON.parse(signal.positionSizing)
        : signal.positionSizing)
    : null;

  const newsValidation = signal.newsValidation
    ? (typeof signal.newsValidation === "string"
        ? JSON.parse(signal.newsValidation)
        : signal.newsValidation)
    : undefined;

  const reasoning = signal.reasoning
    ? (typeof signal.reasoning === "string"
        ? JSON.parse(signal.reasoning)
        : signal.reasoning)
    : [];

  const outcome = (signal.status === "ACCEPTED" || signal.status === "SHADOW_ACCEPTED") ? "executed" : "rejected";
  const headline = (signal.status === "SHADOW_ACCEPTED")
    ? `Shadow approval (autonomy off) · ${reasoning[0] ?? ""}`
    : (reasoning[0] ?? "");

  let rejections = undefined;
  if (outcome === "rejected" && signal.executionResult) {
    rejections = [{ code: "REJECT", message: signal.executionResult }];
  }

  return {
    id: signal.id,
    symbol: signal.symbol,
    at: new Date(signal.timestamp).getTime(),
    decision: signal.finalAction as any,
    setupQuality: positionSizing?.setupQuality ?? "B",
    confidence: signal.confidence,
    outcome,
    rejectionReason: outcome === "rejected" ? (signal.executionResult ?? undefined) : undefined,
    rejections,
    orderId: outcome === "executed" && signal.status !== "SHADOW_ACCEPTED" ? (signal.executionResult ?? undefined) : undefined,
    headline,
    quality: positionSizing ? {
      qualityScore: positionSizing.qualityScore ?? 0,
      grade: positionSizing.qualityGrade ?? "B",
      expectedProfitPercent: positionSizing.expectedProfitPercent ?? 0,
      expectedLossPercent: positionSizing.expectedLossPercent ?? 0,
      riskRewardRatio: positionSizing.rr ?? signal.riskRewardRatio ?? 0,
      volatilityScore: positionSizing.volatilityScore ?? 0,
      marketRegime: signal.trendRegime ?? "Sideways",
    } : undefined,
    newsValidation,
  };
}

function mapSignalToDecisionEntry(signal: any): DecisionEntry {
  const positionSizing = signal.positionSizing
    ? (typeof signal.positionSizing === "string"
        ? JSON.parse(signal.positionSizing)
        : signal.positionSizing)
    : null;

  const newsValidation = signal.newsValidation
    ? (typeof signal.newsValidation === "string"
        ? JSON.parse(signal.newsValidation)
        : signal.newsValidation)
    : undefined;

  const reasoning = signal.reasoning
    ? (typeof signal.reasoning === "string"
        ? JSON.parse(signal.reasoning)
        : signal.reasoning)
    : [];

  const decision: MarketDecision = {
    decision: signal.finalAction as any,
    confidence: signal.confidence,
    setupQuality: positionSizing?.setupQuality ?? "B",
    riskLevel: "Low",
    executeTrade: signal.status === "ACCEPTED",
    positionSizePercent: positionSizing?.equityPercent ?? 0,
    expectedHoldTimeMinutes: 60,
    entryPrice: signal.slPrice ? (signal.side === "LONG" ? signal.slPrice * 1.01 : signal.slPrice * 0.99) : 0,
    takeProfit: signal.tpPrice ?? 0,
    stopLoss: signal.slPrice ?? 0,
    reasoning,
    warnings: [],
    marketSummary: "",
  };

  return {
    decision,
    generatedAt: new Date(signal.timestamp).toISOString(),
    provider: "groq",
    model: "server-orchestration",
    key: signal.id,
    newsValidation,
  };
}

export function AiDecisionProvider({ children }: { children?: React.ReactNode }) {
  useEffect(() => {
    async function syncLogs() {
      try {
        const res = await getRecentExecutionLogs();
        if (!res.ok) return;

        const mappedLogs = res.recentLogs.map(mapSignalToLogEntry);
        
        const bySymbolUpdates: Record<string, DecisionEntry> = {};
        res.latestDecisions.forEach((sig) => {
          bySymbolUpdates[sig.symbol] = mapSignalToDecisionEntry(sig);
        });

        useAiDecisionStore.setState((state) => ({
          executionLog: mappedLogs,
          bySymbol: {
            ...state.bySymbol,
            ...bySymbolUpdates,
          },
        }));
      } catch (err) {
        // Quietly fail or log to prevent uncaught promise errors in background polling
        console.error("[AiDecisionProvider] failed to sync logs", err);
      }
    }

    void syncLogs();

    const interval = setInterval(() => {
      void syncLogs();
    }, 5000);

    return () => clearInterval(interval);
  }, []);

  return <>{children}</>;
}
