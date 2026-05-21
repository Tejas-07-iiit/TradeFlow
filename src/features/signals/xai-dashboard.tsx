"use client";

import React, { useState, useEffect } from "react";
import { 
  Brain, 
  CheckCircle2, 
  XCircle, 
  AlertCircle, 
  Filter, 
  Sparkles, 
  TrendingUp, 
  TrendingDown, 
  ArrowUpRight, 
  Newspaper, 
  Clock, 
  ShieldAlert, 
  Activity, 
  Scale, 
  Lock, 
  RefreshCw, 
  Sliders, 
  Search, 
  Check, 
  Compass, 
  Coins, 
  Gauge, 
  Flame,
  HelpCircle
} from "lucide-react";
import { formatDistanceToNowStrict } from "date-fns";
import { cn } from "@/lib/utils";
import { PageShell, StatusBadge } from "@/components/shared/page-shell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getExplainableSignals } from "@/server/xai-signals";

interface SignalRecord {
  id: string;
  symbol: string;
  side: string;
  timestamp: Date | string;
  status: string;
  confidence: number;
  finalAction: string;
  executionResult: string | null;
  
  // Technical Analysis
  emaAlignment: string;
  rsi: number | null;
  macd: any; // { macd, signalLine, histogram }
  vwap: number | null;
  volatility: number | null;
  trendRegime: string;
  supportPrice: number | null;
  resistancePrice: number | null;
  momentumAnalysis: string | null;

  // Candlestick Patterns
  candlestickPatterns: any; // CandlestickIntelligence

  // News Validation
  newsValidation: any;

  // AI Reasoning
  reasoning: any; // string[]

  // Risk Engine
  slPrice: number | null;
  tpPrice: number | null;
  riskRewardRatio: number | null;
  leverageAdjustment: string | null;
  sizeAdjustment: string | null;
  positionSizing: any;

  // Execution Validator
  entryDrift: number | null;
  spreadValidation: string | null;
  liquidityChecks: string | null;
  newsVetoResult: string | null;
}

export function XaiDashboard() {
  const [signals, setSignals] = useState<SignalRecord[]>([]);
  const [selectedSignal, setSelectedSignal] = useState<SignalRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [sideFilter, setSideFilter] = useState("ALL");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  // Load signals
  useEffect(() => {
    let active = true;

    async function loadData() {
      try {
        const filters = {
          symbol: searchTerm.trim() ? searchTerm.toUpperCase() : "ALL",
          status: statusFilter,
        };
        const res = await getExplainableSignals(filters);
        if (!active) return;

        if (res.ok && res.signals) {
          // Additional client-side filtering for side if active
          let filtered = res.signals as unknown as SignalRecord[];
          if (sideFilter !== "ALL") {
            filtered = filtered.filter(s => s.side === sideFilter);
          }

          setSignals(filtered);
          setError(null);

          // Update selected signal if it's already set or pick the first one
          if (filtered.length > 0) {
            setSelectedSignal(prev => {
              if (!prev) return filtered[0];
              const updated = filtered.find(s => s.id === prev.id);
              return updated || filtered[0];
            });
          } else {
            setSelectedSignal(null);
          }
        } else {
          setError(res.error || "Failed to load signals");
        }
      } catch (err) {
        if (active) {
          setError("Network or system error loading signals");
          console.error(err);
        }
      } finally {
        if (active) setLoading(false);
      }
    }

    loadData();

    return () => {
      active = false;
    };
  }, [searchTerm, statusFilter, sideFilter, refreshTrigger]);

  // Polling interval
  useEffect(() => {
    if (!autoRefresh) return;
    const intervalId = setInterval(() => {
      setRefreshTrigger(prev => prev + 1);
    }, 5000);

    return () => clearInterval(intervalId);
  }, [autoRefresh]);

  const handleRefresh = () => {
    setLoading(true);
    setRefreshTrigger(prev => prev + 1);
  };

  // Helper to determine status tone/badges
  const getStatusDetails = (status: string) => {
    switch (status) {
      case "ACCEPTED":
        return { label: "Accepted", tone: "bull" as const, desc: "Signal passed all checks and was auto-executed." };
      case "REJECTED":
        return { label: "Rejected", tone: "bear" as const, desc: "Blocked by risk engine, news veto, or execution constraints." };
      case "MODIFIED":
        return { label: "Modified", tone: "warn" as const, desc: "Size scaled down or rules modified before execution." };
      case "SHADOW_ACCEPTED":
        return { label: "Shadow Approved", tone: "accent" as const, desc: "Approved in shadow/monitoring mode (live trade bypassed)." };
      default:
        return { label: status, tone: "muted" as const, desc: "Signal parsed but status is unknown." };
    }
  };

  const getSideDetails = (side: string) => {
    if (side === "LONG") {
      return { label: "LONG", className: "text-[var(--color-bull)] bg-[var(--color-bull-soft)] border-[var(--color-bull)]/20", icon: TrendingUp };
    }
    return { label: "SHORT", className: "text-[var(--color-bear)] bg-[var(--color-bear-soft)] border-[var(--color-bear)]/20", icon: TrendingDown };
  };

  return (
    <PageShell
      eyebrow="AI Signal Workstation"
      title="Explainable Signal Intelligence"
      description="Deep reasoning audit log for every final trading decision. Tracks live indicators, news context, and execution guardrails."
      action={
        <div className="flex items-center gap-2">
          <button
            onClick={() => setAutoRefresh(prev => !prev)}
            className={cn(
              "flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-all cursor-pointer",
              autoRefresh 
                ? "bg-[var(--color-accent-soft)] text-[var(--color-accent)] border-[var(--color-accent)]/20" 
                : "bg-[var(--surface-elevated)] text-[var(--color-fg-muted)] border-[var(--color-border)]"
            )}
          >
            <Clock className="size-3.5" />
            {autoRefresh ? "Auto-refresh: On" : "Auto-refresh: Off"}
          </button>
          <button
            onClick={handleRefresh}
            className="flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] px-3 py-1.5 text-xs font-semibold text-[var(--color-fg)] hover:bg-[var(--color-card-hover)] transition-all cursor-pointer"
          >
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
            Refresh
          </button>
        </div>
      }
    >
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[400px_minmax(0,1fr)]">
        
        {/* LEFT COLUMN: SIGNALS FEED */}
        <div className="space-y-4">
          <Card className="border border-[var(--color-border)] bg-[var(--color-card)] shadow-[var(--shadow-card)]">
            <CardHeader className="border-b border-[var(--color-border)] p-4 flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-semibold text-[var(--color-fg)] flex items-center gap-2">
                  <Filter className="size-4 text-[var(--color-accent)]" />
                  Signals Ledger
                </CardTitle>
                <Badge variant="muted" className="text-[10px]">
                  {signals.length} recorded
                </Badge>
              </div>

              {/* Filters grid */}
              <div className="space-y-2">
                <div className="relative">
                  <Search className="absolute left-2.5 top-2.5 size-3.5 text-[var(--color-fg-subtle)]" />
                  <input
                    type="text"
                    placeholder="Search symbol (e.g. BTCUSDT)..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="w-full rounded-md border border-[var(--color-border)] bg-[var(--surface-elevated)] py-1.5 pl-8 pr-3 text-xs text-[var(--color-fg)] placeholder-[var(--color-fg-subtle)] focus:border-[var(--color-border-strong)] focus:outline-none"
                  />
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[10px] uppercase font-semibold text-[var(--color-fg-subtle)] mb-1 block">Status</label>
                    <select
                      value={statusFilter}
                      onChange={(e) => setStatusFilter(e.target.value)}
                      className="w-full rounded-md border border-[var(--color-border)] bg-[var(--surface-elevated)] p-1.5 text-xs text-[var(--color-fg)] focus:outline-none focus:border-[var(--color-border-strong)]"
                    >
                      <option value="ALL">All Statuses</option>
                      <option value="ACCEPTED">Accepted</option>
                      <option value="REJECTED">Rejected</option>
                      <option value="MODIFIED">Modified</option>
                      <option value="SHADOW_ACCEPTED">Shadow Approved</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-[10px] uppercase font-semibold text-[var(--color-fg-subtle)] mb-1 block">Direction</label>
                    <select
                      value={sideFilter}
                      onChange={(e) => setSideFilter(e.target.value)}
                      className="w-full rounded-md border border-[var(--color-border)] bg-[var(--surface-elevated)] p-1.5 text-xs text-[var(--color-fg)] focus:outline-none focus:border-[var(--color-border-strong)]"
                    >
                      <option value="ALL">All Sides</option>
                      <option value="LONG">Long</option>
                      <option value="SHORT">Short</option>
                    </select>
                  </div>
                </div>
              </div>
            </CardHeader>
            
            <CardContent className="p-2 max-h-[640px] overflow-y-auto space-y-2">
              {loading && signals.length === 0 ? (
                <div className="py-12 text-center text-xs text-[var(--color-fg-muted)] flex flex-col items-center gap-2">
                  <RefreshCw className="size-5 animate-spin text-[var(--color-accent)]" />
                  Analyzing ledger logs...
                </div>
              ) : error ? (
                <div className="py-8 text-center text-xs text-[var(--color-bear)] p-4 bg-[var(--color-bear-soft)] rounded-md border border-[var(--color-bear)]/20">
                  {error}
                </div>
              ) : signals.length === 0 ? (
                <div className="py-16 text-center text-xs text-[var(--color-fg-subtle)] px-4">
                  <Brain className="size-8 mx-auto text-[var(--color-fg-subtle)]/40 mb-3" />
                  <p className="font-medium text-[var(--color-fg-muted)] mb-1">No final signals captured</p>
                  <p className="max-w-[280px] mx-auto text-[var(--color-fg-subtle)] leading-relaxed">
                    The autonomous agent is currently active. When an actionable trade proposal is generated, verified, and concluded, its XAI report will appear here.
                  </p>
                </div>
              ) : (
                signals.map((sig) => {
                  const statusInfo = getStatusDetails(sig.status);
                  const sideInfo = getSideDetails(sig.side);
                  const isSelected = selectedSignal?.id === sig.id;

                  return (
                    <div
                      key={sig.id}
                      onClick={() => setSelectedSignal(sig)}
                      className={cn(
                        "group flex flex-col rounded-lg border p-3 transition-all cursor-pointer text-left",
                        isSelected
                          ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)] shadow-sm"
                          : "border-[var(--color-border)] bg-[var(--color-card)] hover:bg-[var(--color-card-hover)] hover:border-[var(--color-border-strong)]"
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-sm text-[var(--color-fg)]">
                            {sig.symbol}
                          </span>
                          <span className={cn("text-[9px] font-semibold px-2 py-0.5 rounded border tracking-wide uppercase", sideInfo.className)}>
                            {sideInfo.label}
                          </span>
                        </div>
                        <StatusBadge tone={statusInfo.tone}>
                          {statusInfo.label}
                        </StatusBadge>
                      </div>

                      <div className="mt-2.5 flex items-center justify-between text-xs">
                        <div className="flex items-center gap-1 text-[var(--color-fg-subtle)]">
                          <Clock className="size-3" />
                          <span>
                            {formatDistanceToNowStrict(new Date(sig.timestamp), { addSuffix: true })}
                          </span>
                        </div>
                        <div className="text-right">
                          <span className="font-semibold text-[var(--color-fg-muted)]">
                            {sig.confidence}% Confidence
                          </span>
                        </div>
                      </div>

                      <div className="mt-2 text-xs border-t border-[var(--color-border)] pt-2 text-[var(--color-fg-muted)] line-clamp-1">
                        <span className="font-medium text-[var(--color-fg)]">Action:</span> {sig.finalAction} {sig.executionResult ? `· ${sig.executionResult.split("\n")[0]}` : ""}
                      </div>
                    </div>
                  );
                })
              )}
            </CardContent>
          </Card>
        </div>

        {/* RIGHT COLUMN: DETAILED SIGNAL INTELLIGENCE INSPECTOR */}
        <div className="space-y-4">
          {!selectedSignal ? (
            <Card className="border border-dashed border-[var(--color-border-strong)] bg-[var(--surface-elevated)] p-12 text-center h-[600px] flex flex-col justify-center items-center">
              <Brain className="size-16 text-[var(--color-accent)] opacity-40 animate-pulse mb-4" />
              <div className="text-base font-semibold text-[var(--color-fg)]">
                Select a Signal Intelligence Report
              </div>
              <p className="mt-2 max-w-sm text-sm text-[var(--color-fg-muted)] leading-relaxed">
                Click on any verified trade proposal decision in the left sidebar to audit its deep reasoning chain, news sentiment veto results, risk adjustments, and candlestick pattern confirmations.
              </p>
            </Card>
          ) : (
            <div className="space-y-4 fade-in">
              
              {/* INSPECTOR HEADER: CORE DETAILS & STATUS */}
              <Card className="border border-[var(--color-border)] bg-[var(--color-card)] shadow-[var(--shadow-card)] overflow-hidden relative">
                {/* Glow accent band */}
                <div className={cn(
                  "h-1.5 w-full",
                  selectedSignal.status === "ACCEPTED" && "bg-[var(--color-bull)]",
                  selectedSignal.status === "REJECTED" && "bg-[var(--color-bear)]",
                  selectedSignal.status === "MODIFIED" && "bg-[var(--color-warn)]",
                  selectedSignal.status === "SHADOW_ACCEPTED" && "bg-[var(--color-accent)]"
                )} />

                <div className="p-5 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div className="space-y-2.5">
                    <div className="flex items-center gap-3">
                      <h2 className="text-2xl font-bold tracking-tight text-[var(--color-fg)]">
                        {selectedSignal.symbol}
                      </h2>
                      <span className={cn(
                        "text-xs font-semibold px-2.5 py-0.5 rounded-full border tracking-wider",
                        selectedSignal.side === "LONG" 
                          ? "text-[var(--color-bull)] bg-[var(--color-bull-soft)] border-[var(--color-bull)]/20" 
                          : "text-[var(--color-bear)] bg-[var(--color-bear-soft)] border-[var(--color-bear)]/20"
                      )}>
                        {selectedSignal.side} DIRECTION
                      </span>
                      <StatusBadge tone={getStatusDetails(selectedSignal.status).tone}>
                        {getStatusDetails(selectedSignal.status).label}
                      </StatusBadge>
                    </div>

                    <p className="text-xs text-[var(--color-fg-muted)] flex items-center gap-2">
                      <Clock className="size-3.5 text-[var(--color-accent)]" />
                      <span>Captured: {new Date(selectedSignal.timestamp).toLocaleString()}</span>
                      <span>·</span>
                      <span className="font-semibold text-[var(--color-fg)]">ID: {selectedSignal.id}</span>
                    </p>

                    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--surface-elevated)] p-3 text-xs leading-relaxed max-w-2xl">
                      <div className="font-semibold text-[var(--color-fg)] uppercase tracking-wider text-[9px] mb-1">
                        Execution Ledger & Event Context
                      </div>
                      <div className="text-[var(--color-fg-muted)] text-mono-tabular break-words whitespace-pre-line font-medium">
                        {selectedSignal.executionResult || "No execution errors or exceptions occurred."}
                      </div>
                    </div>
                  </div>

                  {/* Confidences & Quality rating dials */}
                  <div className="flex items-center gap-5 shrink-0 bg-[var(--surface-elevated)] rounded-xl border border-[var(--color-border)] p-4">
                    {/* SVG Radial Confidence */}
                    <div className="relative size-16">
                      <svg className="size-full -rotate-90" viewBox="0 0 36 36">
                        {/* Background track */}
                        <path
                          className="text-[var(--color-border-strong)] opacity-20"
                          strokeWidth="3.5"
                          stroke="currentColor"
                          fill="none"
                          d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                        />
                        {/* Colored progress bar */}
                        <path
                          className={cn(
                            selectedSignal.confidence >= 75 ? "text-[var(--color-bull)]" : selectedSignal.confidence >= 55 ? "text-[var(--color-warn)]" : "text-[var(--color-bear)]"
                          )}
                          strokeDasharray={`${selectedSignal.confidence}, 100`}
                          strokeWidth="3.5"
                          strokeLinecap="round"
                          stroke="currentColor"
                          fill="none"
                          d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                        />
                      </svg>
                      <div className="absolute inset-0 flex flex-col items-center justify-center">
                        <span className="text-sm font-bold text-[var(--color-fg)]">
                          {selectedSignal.confidence}%
                        </span>
                        <span className="text-[7px] font-medium text-[var(--color-fg-subtle)] uppercase">
                          Conf
                        </span>
                      </div>
                    </div>

                    <div className="text-left">
                      <div className="text-[10px] uppercase font-semibold text-[var(--color-fg-subtle)] tracking-wider">
                        Setup Grade
                      </div>
                      <div className="text-2xl font-black text-[var(--color-accent)] tracking-tight">
                        {selectedSignal.confidence >= 85 ? "A+" : selectedSignal.confidence >= 75 ? "A-" : selectedSignal.confidence >= 65 ? "B" : "C"}
                      </div>
                      <div className="text-[9px] text-[var(--color-fg-muted)] font-medium">
                        Rule Weighted Scoring
                      </div>
                    </div>
                  </div>
                </div>
              </Card>

              {/* SECTION 1: AI LLM REASONING TERMINAL */}
              <Card className="border border-[var(--color-border)] bg-[var(--color-card)] shadow-[var(--shadow-card)]">
                <CardHeader className="border-b border-[var(--color-border)] p-4 flex items-center justify-between">
                  <CardTitle className="text-xs font-bold text-[var(--color-fg)] uppercase tracking-wider flex items-center gap-2">
                    <Brain className="size-4 text-[var(--color-accent)]" />
                    AI Reasoning Agent Logic
                  </CardTitle>
                  <Badge variant="accent" className="text-[9px] tracking-widest font-mono">
                    LLM.INTELLIGENCE
                  </Badge>
                </CardHeader>
                <CardContent className="p-4 bg-[var(--bg-elevated)] font-mono text-xs">
                  {selectedSignal.reasoning && Array.isArray(selectedSignal.reasoning) && selectedSignal.reasoning.length > 0 ? (
                    <ul className="space-y-3">
                      {selectedSignal.reasoning.map((point: string, idx: number) => (
                        <li key={idx} className="flex gap-3 text-[var(--color-fg-muted)] leading-relaxed">
                          <span className="text-[var(--color-accent)] font-bold shrink-0">[{idx + 1}]</span>
                          <span className="text-[var(--color-fg)]">{point}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="text-[var(--color-fg-subtle)] italic p-2 text-center">
                      No discrete LLM reasoning segments were logged for this decision.
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* SECTION 2: TECHNICAL ANALYSIS MATRIX */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                
                {/* TECHNICAL INDICATOR SNAPSHOTS */}
                <Card className="border border-[var(--color-border)] bg-[var(--color-card)] shadow-[var(--shadow-card)]">
                  <CardHeader className="border-b border-[var(--color-border)] p-4">
                    <CardTitle className="text-xs font-bold text-[var(--color-fg)] uppercase tracking-wider flex items-center gap-2">
                      <Activity className="size-4 text-[var(--color-bull)]" />
                      Indicator Matrix Snapshot
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-4 space-y-3">
                    
                    {/* EMA Alignment Row */}
                    <div className="flex items-center justify-between p-2 rounded bg-[var(--surface-elevated)] border border-[var(--color-border)]">
                      <span className="text-xs text-[var(--color-fg-muted)] font-medium">EMA Alignment</span>
                      <span className={cn(
                        "text-xs font-bold",
                        selectedSignal.emaAlignment.toLowerCase().includes("bullish") && "text-[var(--color-bull)]",
                        selectedSignal.emaAlignment.toLowerCase().includes("bearish") && "text-[var(--color-bear)]"
                      )}>
                        {selectedSignal.emaAlignment}
                      </span>
                    </div>

                    {/* RSI Row with mini scale */}
                    <div className="space-y-1.5 p-2 rounded bg-[var(--surface-elevated)] border border-[var(--color-border)]">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-[var(--color-fg-muted)] font-medium">RSI (14) Snapshot</span>
                        <span className={cn(
                          "text-xs font-mono font-bold",
                          selectedSignal.rsi && selectedSignal.rsi >= 70 ? "text-[var(--color-bear)]" : selectedSignal.rsi && selectedSignal.rsi <= 30 ? "text-[var(--color-bull)]" : "text-[var(--color-accent)]"
                        )}>
                          {selectedSignal.rsi ? selectedSignal.rsi.toFixed(2) : "—"}
                        </span>
                      </div>
                      
                      {selectedSignal.rsi != null && (
                        <div className="relative h-2 w-full bg-[var(--color-border-strong)]/30 rounded-full overflow-hidden">
                          {/* Oversold marker line */}
                          <div className="absolute left-[30%] top-0 bottom-0 w-0.5 bg-[var(--color-bull)]/40 z-10" title="Oversold floor" />
                          {/* Overbought marker line */}
                          <div className="absolute left-[70%] top-0 bottom-0 w-0.5 bg-[var(--color-bear)]/40 z-10" title="Overbought ceiling" />
                          {/* Value marker */}
                          <div 
                            className={cn(
                              "absolute h-full w-2 rounded-full -translate-x-1/2",
                              selectedSignal.rsi >= 70 ? "bg-[var(--color-bear)]" : selectedSignal.rsi <= 30 ? "bg-[var(--color-bull)]" : "bg-[var(--color-accent)]"
                            )} 
                            style={{ left: `${selectedSignal.rsi}%` }} 
                          />
                        </div>
                      )}
                    </div>

                    {/* MACD, VWAP, VOLATILITY SNAPSHOTS */}
                    <div className="grid grid-cols-2 gap-2">
                      <div className="p-2 rounded bg-[var(--surface-elevated)] border border-[var(--color-border)] text-xs">
                        <div className="text-[10px] uppercase font-semibold text-[var(--color-fg-subtle)]">VWAP Price Link</div>
                        <div className="mt-1 font-bold text-[var(--color-fg)]">
                          {selectedSignal.vwap ? `$${selectedSignal.vwap.toLocaleString()}` : "—"}
                        </div>
                      </div>
                      <div className="p-2 rounded bg-[var(--surface-elevated)] border border-[var(--color-border)] text-xs">
                        <div className="text-[10px] uppercase font-semibold text-[var(--color-fg-subtle)]">Volatility (ATR%)</div>
                        <div className="mt-1 font-bold text-[var(--color-fg)]">
                          {selectedSignal.volatility ? `${selectedSignal.volatility.toFixed(2)}%` : "—"}
                        </div>
                      </div>
                    </div>

                    {/* Support & Resistance zones */}
                    <div className="p-2 rounded bg-[var(--surface-elevated)] border border-[var(--color-border)] text-xs space-y-1.5">
                      <div className="text-[10px] uppercase font-semibold text-[var(--color-fg-subtle)]">30-Bar Support / Resistance Zones</div>
                      <div className="flex justify-between items-center text-mono-tabular">
                        <span className="text-[var(--color-bear)] font-medium">Res: {selectedSignal.resistancePrice ? `$${selectedSignal.resistancePrice.toLocaleString()}` : "—"}</span>
                        <span className="text-[var(--color-fg-subtle)]">|</span>
                        <span className="text-[var(--color-bull)] font-medium">Sup: {selectedSignal.supportPrice ? `$${selectedSignal.supportPrice.toLocaleString()}` : "—"}</span>
                      </div>
                    </div>

                    {/* Trend Regime */}
                    <div className="p-2.5 rounded bg-[var(--color-accent-soft)]/40 border border-[var(--color-accent)]/15 text-xs flex justify-between items-center">
                      <span className="font-semibold text-[var(--color-accent)]">Trend Regime Classification</span>
                      <Badge variant="accent" className="font-bold">{selectedSignal.trendRegime || "PENDING"}</Badge>
                    </div>

                  </CardContent>
                </Card>

                {/* CANDLESTICK PATTERN RECOGNITION */}
                <Card className="border border-[var(--color-border)] bg-[var(--color-card)] shadow-[var(--shadow-card)]">
                  <CardHeader className="border-b border-[var(--color-border)] p-4 flex items-center justify-between">
                    <CardTitle className="text-xs font-bold text-[var(--color-fg)] uppercase tracking-wider flex items-center gap-2">
                      <Sparkles className="size-4 text-[var(--color-accent)]" />
                      Candlestick Pattern Intelligence
                    </CardTitle>
                    {selectedSignal.candlestickPatterns?.netBias != null && (
                      <Badge variant={selectedSignal.candlestickPatterns.netBias > 0 ? "bull" : selectedSignal.candlestickPatterns.netBias < 0 ? "bear" : "muted"} className="font-bold text-[9px]">
                        Bias: {selectedSignal.candlestickPatterns.netBias > 0 ? "+" : ""}{selectedSignal.candlestickPatterns.netBias}%
                      </Badge>
                    )}
                  </CardHeader>
                  <CardContent className="p-4 space-y-3.5">
                    <div className="text-xs leading-relaxed text-[var(--color-fg-muted)] italic bg-[var(--surface-elevated)] p-2.5 rounded border border-[var(--color-border)]">
                      "{selectedSignal.candlestickPatterns?.narrative || "No active candlestick formations detected in the evaluation window."}"
                    </div>

                    {/* Pattern detections */}
                    <div className="space-y-1.5">
                      <div className="text-[10px] uppercase font-bold text-[var(--color-fg-subtle)] tracking-wider">
                        Detected Formations ({selectedSignal.candlestickPatterns?.detections?.length || 0})
                      </div>
                      
                      {selectedSignal.candlestickPatterns?.detections && selectedSignal.candlestickPatterns.detections.length > 0 ? (
                        <div className="space-y-1.5 max-h-[160px] overflow-y-auto pr-1">
                          {selectedSignal.candlestickPatterns.detections.map((det: any, i: number) => (
                            <div key={i} className="flex justify-between items-center bg-[var(--surface-elevated)] p-2 rounded border border-[var(--color-border)] text-xs">
                              <div className="flex items-center gap-2">
                                <span className={cn(
                                  "size-2 rounded-full",
                                  det.direction === "bullish" ? "bg-[var(--color-bull)]" : "bg-[var(--color-bear)]"
                                )} />
                                <span className="font-semibold text-[var(--color-fg)]">{det.patternName}</span>
                                <span className="text-[9px] text-[var(--color-fg-subtle)] uppercase">({det.category})</span>
                              </div>
                              <span className="font-mono font-bold text-[var(--color-accent)]">{det.confidenceScore}% Confidence</span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="text-xs text-[var(--color-fg-subtle)] text-center py-4 bg-[var(--surface-elevated)] rounded border border-[var(--color-border)] border-dashed">
                          No specific candle patterns met the 50% confidence barrier.
                        </div>
                      )}
                    </div>
                  </CardContent>
                </Card>

              </div>

              {/* SECTION 3: RISK ENGINE & SIZING INTEGRITY */}
              <Card className="border border-[var(--color-border)] bg-[var(--color-card)] shadow-[var(--shadow-card)]">
                <CardHeader className="border-b border-[var(--color-border)] p-4 flex items-center justify-between">
                  <CardTitle className="text-xs font-bold text-[var(--color-fg)] uppercase tracking-wider flex items-center gap-2">
                    <Scale className="size-4 text-[var(--color-warn)]" />
                    Risk Engine & Sizing Integrity
                  </CardTitle>
                  {selectedSignal.riskRewardRatio != null && (
                    <Badge variant="warn" className="font-bold text-[9px]">
                      R:R {selectedSignal.riskRewardRatio.toFixed(2)}
                    </Badge>
                  )}
                </CardHeader>
                <CardContent className="p-4 space-y-4">
                  
                  {/* SL / TP Pricing Bands */}
                  <div className="grid grid-cols-2 gap-4">
                    <div className="border border-[var(--color-border)] bg-[var(--surface-elevated)] p-3 rounded-lg flex items-center justify-between">
                      <div>
                        <div className="text-[9px] uppercase font-bold text-[var(--color-fg-subtle)] tracking-wider">Stop Loss (SL)</div>
                        <div className="text-mono-tabular text-sm font-bold text-[var(--color-bear)] mt-1">
                          {selectedSignal.slPrice ? `$${selectedSignal.slPrice.toLocaleString()}` : "Not Set"}
                        </div>
                      </div>
                      <ShieldAlert className="size-5 text-[var(--color-bear)]/50" />
                    </div>

                    <div className="border border-[var(--color-border)] bg-[var(--surface-elevated)] p-3 rounded-lg flex items-center justify-between">
                      <div>
                        <div className="text-[9px] uppercase font-bold text-[var(--color-fg-subtle)] tracking-wider">Take Profit (TP)</div>
                        <div className="text-mono-tabular text-sm font-bold text-[var(--color-bull)] mt-1">
                          {selectedSignal.tpPrice ? `$${selectedSignal.tpPrice.toLocaleString()}` : "Not Set"}
                        </div>
                      </div>
                      <CheckCircle2 className="size-5 text-[var(--color-bull)]/50" />
                    </div>
                  </div>

                  {/* Sizing Details */}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                    <div className="p-2.5 rounded bg-[var(--surface-elevated)] border border-[var(--color-border)]">
                      <div className="text-[9px] uppercase font-semibold text-[var(--color-fg-subtle)]">Notional Value</div>
                      <div className="font-bold text-mono-tabular text-[var(--color-fg)] mt-0.5">
                        {selectedSignal.positionSizing?.notional != null 
                          ? `$${selectedSignal.positionSizing.notional.toLocaleString()}` 
                          : "—"}
                      </div>
                    </div>
                    
                    <div className="p-2.5 rounded bg-[var(--surface-elevated)] border border-[var(--color-border)]">
                      <div className="text-[9px] uppercase font-semibold text-[var(--color-fg-subtle)]">Equity Risk %</div>
                      <div className="font-bold text-mono-tabular text-[var(--color-fg)] mt-0.5">
                        {selectedSignal.positionSizing?.riskPercent != null 
                          ? `${selectedSignal.positionSizing.riskPercent.toFixed(2)}%` 
                          : "—"}
                      </div>
                    </div>

                    <div className="p-2.5 rounded bg-[var(--surface-elevated)] border border-[var(--color-border)]">
                      <div className="text-[9px] uppercase font-semibold text-[var(--color-fg-subtle)]">Max Risk Amount</div>
                      <div className="font-bold text-mono-tabular text-[var(--color-fg)] mt-0.5">
                        {selectedSignal.positionSizing?.riskAmount != null 
                          ? `$${selectedSignal.positionSizing.riskAmount.toFixed(2)}` 
                          : "—"}
                      </div>
                    </div>

                    <div className="p-2.5 rounded bg-[var(--surface-elevated)] border border-[var(--color-border)]">
                      <div className="text-[9px] uppercase font-semibold text-[var(--color-fg-subtle)]">Size Multiplier</div>
                      <div className="font-bold text-mono-tabular text-[var(--color-accent)] mt-0.5">
                        {selectedSignal.positionSizing?.externalSizeMultiplier != null 
                          ? `${selectedSignal.positionSizing.externalSizeMultiplier.toFixed(2)}x` 
                          : "1.00x"}
                      </div>
                    </div>
                  </div>

                  {/* Leverage Adjustment & Size Multiplier summary */}
                  <div className="rounded-lg bg-[var(--surface-elevated)] border border-[var(--color-border)] p-3 text-xs space-y-2">
                    <div className="flex justify-between items-center text-xs">
                      <span className="text-[var(--color-fg-muted)] font-medium">Leverage Applied:</span>
                      <span className="font-bold text-[var(--color-fg)]">{selectedSignal.leverageAdjustment || "1x (Spot / Shadow Equivalent)"}</span>
                    </div>
                    <div className="flex justify-between items-center text-xs">
                      <span className="text-[var(--color-fg-muted)] font-medium">Sizing Adjustments:</span>
                      <span className="font-bold text-[var(--color-fg)]">{selectedSignal.sizeAdjustment || "None"}</span>
                    </div>
                    {selectedSignal.positionSizing?.rationale && (
                      <div className="border-t border-[var(--color-border)] pt-2 mt-1 text-[var(--color-fg-muted)] leading-relaxed italic text-[11px]">
                        "{selectedSignal.positionSizing.rationale}"
                      </div>
                    )}
                  </div>

                </CardContent>
              </Card>

              {/* SECTION 4: NEWS SENTIMENT VETO ASSESSMENT */}
              <Card className="border border-[var(--color-border)] bg-[var(--color-card)] shadow-[var(--shadow-card)]">
                <CardHeader className="border-b border-[var(--color-border)] p-4 flex items-center justify-between">
                  <CardTitle className="text-xs font-bold text-[var(--color-fg)] uppercase tracking-wider flex items-center gap-2">
                    <Newspaper className="size-4 text-[var(--color-accent)]" />
                    News Sentiment & Sentiment Veto Assessment
                  </CardTitle>
                  {selectedSignal.newsValidation?.sentiment && (
                    <Badge variant={
                      selectedSignal.newsValidation.sentiment.toLowerCase() === "bullish" ? "bull" :
                      selectedSignal.newsValidation.sentiment.toLowerCase() === "bearish" ? "bear" : "muted"
                    } className="font-bold text-[9px]">
                      Sentiment: {selectedSignal.newsValidation.sentiment}
                    </Badge>
                  )}
                </CardHeader>
                <CardContent className="p-4 space-y-4">
                  
                  {/* Sentiment stats header */}
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                    <div className="p-2.5 rounded bg-[var(--surface-elevated)] border border-[var(--color-border)]">
                      <div className="text-[9px] uppercase font-semibold text-[var(--color-fg-subtle)]">News Risk Index</div>
                      <div className="font-bold text-[var(--color-fg)] mt-0.5">
                        {selectedSignal.newsValidation?.riskIndex != null 
                          ? `${(selectedSignal.newsValidation.riskIndex * 100).toFixed(0)}/100` 
                          : "0/100"}
                      </div>
                    </div>
                    <div className="p-2.5 rounded bg-[var(--surface-elevated)] border border-[var(--color-border)]">
                      <div className="text-[9px] uppercase font-semibold text-[var(--color-fg-subtle)]">Macro Score</div>
                      <div className="font-bold text-[var(--color-fg)] mt-0.5">
                        {selectedSignal.newsValidation?.score != null 
                          ? selectedSignal.newsValidation.score.toFixed(2) 
                          : "0.00"}
                      </div>
                    </div>
                    <div className="p-2.5 rounded bg-[var(--surface-elevated)] border border-[var(--color-border)]">
                      <div className="text-[9px] uppercase font-semibold text-[var(--color-fg-subtle)]">News Engine Action</div>
                      <div className="font-bold text-[var(--color-fg)] mt-0.5">
                        {selectedSignal.newsValidation?.action || "PROCEED"}
                      </div>
                    </div>
                  </div>

                  {/* Veto narrative */}
                  {selectedSignal.newsVetoResult && (
                    <div className={cn(
                      "p-3 rounded-lg border text-xs flex gap-2.5 items-start",
                      selectedSignal.newsVetoResult.toLowerCase().includes("vetoed")
                        ? "bg-[var(--color-bear-soft)] border-[var(--color-bear)]/20 text-[var(--color-bear)]"
                        : "bg-[var(--color-bull-soft)] border-[var(--color-bull)]/20 text-[var(--color-bull)]"
                    )}>
                      {selectedSignal.newsVetoResult.toLowerCase().includes("vetoed") ? (
                        <XCircle className="size-4 shrink-0 mt-0.5" />
                      ) : (
                        <CheckCircle2 className="size-4 shrink-0 mt-0.5" />
                      )}
                      <div>
                        <span className="font-bold uppercase tracking-wider text-[10px]">News Veto Result:</span>{" "}
                        <span className="font-medium text-[var(--color-fg)]">{selectedSignal.newsVetoResult}</span>
                      </div>
                    </div>
                  )}

                  {/* Processed Headlines */}
                  <div className="space-y-1.5">
                    <div className="text-[10px] uppercase font-bold text-[var(--color-fg-subtle)] tracking-wider">
                      Macro Headlines Evaluated ({selectedSignal.newsValidation?.headlines?.length || 0})
                    </div>

                    {selectedSignal.newsValidation?.headlines && selectedSignal.newsValidation.headlines.length > 0 ? (
                      <div className="space-y-2 max-h-[180px] overflow-y-auto pr-1">
                        {selectedSignal.newsValidation.headlines.map((item: any, i: number) => (
                          <div key={i} className="bg-[var(--surface-elevated)] p-2.5 rounded border border-[var(--color-border)] text-xs flex flex-col gap-1">
                            <div className="flex justify-between items-start gap-2">
                              <span className="font-semibold text-[var(--color-fg)] line-clamp-2">
                                {item.title || item.headline}
                              </span>
                              {item.sentiment && (
                                <Badge variant={
                                  item.sentiment.toLowerCase() === "bullish" ? "bull" :
                                  item.sentiment.toLowerCase() === "bearish" ? "bear" : "muted"
                                } className="text-[8px] h-4 px-1 py-0.5 font-bold uppercase shrink-0">
                                  {item.sentiment}
                                </Badge>
                              )}
                            </div>
                            <div className="text-[9px] text-[var(--color-fg-subtle)] flex items-center justify-between">
                              <span>Source: {item.source || "CryptoCompare"}</span>
                              {item.impactScore != null && (
                                <span>Impact: {item.impactScore}/10</span>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-xs text-[var(--color-fg-subtle)] text-center py-4 bg-[var(--surface-elevated)] rounded border border-[var(--color-border)] border-dashed">
                        No significant global headlines detected in news scrapers for this period.
                      </div>
                    )}
                  </div>

                </CardContent>
              </Card>

              {/* SECTION 5: EXECUTION VALIDATION CHECKLIST */}
              <Card className="border border-[var(--color-border)] bg-[var(--color-card)] shadow-[var(--shadow-card)]">
                <CardHeader className="border-b border-[var(--color-border)] p-4">
                  <CardTitle className="text-xs font-bold text-[var(--color-fg)] uppercase tracking-wider flex items-center gap-2">
                    <Lock className="size-4 text-[var(--color-bull)]" />
                    Pre-Execution Guardrails Audit Checklist
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-4 space-y-3">
                  
                  {/* Drift check */}
                  <div className="flex items-center justify-between p-2.5 rounded bg-[var(--surface-elevated)] border border-[var(--color-border)] text-xs">
                    <div className="flex items-center gap-2.5">
                      {selectedSignal.entryDrift != null && selectedSignal.entryDrift <= 2.0 ? (
                        <CheckCircle2 className="size-4 text-[var(--color-bull)]" />
                      ) : (
                        <AlertCircle className="size-4 text-[var(--color-bear)]" />
                      )}
                      <div>
                        <div className="font-semibold text-[var(--color-fg)]">Entry Drift Protection</div>
                        <div className="text-[10px] text-[var(--color-fg-subtle)]">Max Allowed: 2.0% deviation</div>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className={cn(
                        "font-bold font-mono text-sm",
                        selectedSignal.entryDrift != null && selectedSignal.entryDrift <= 2.0 ? "text-[var(--color-bull)]" : "text-[var(--color-bear)]"
                      )}>
                        {selectedSignal.entryDrift != null ? `${selectedSignal.entryDrift.toFixed(3)}%` : "0.000%"}
                      </div>
                      <div className="text-[9px] text-[var(--color-fg-muted)]">Computed Drift</div>
                    </div>
                  </div>

                  {/* Spread validation */}
                  <div className="flex items-center justify-between p-2.5 rounded bg-[var(--surface-elevated)] border border-[var(--color-border)] text-xs">
                    <div className="flex items-center gap-2.5">
                      <CheckCircle2 className="size-4 text-[var(--color-bull)]" />
                      <div>
                        <div className="font-semibold text-[var(--color-fg)]">Spread Validation Check</div>
                        <div className="text-[10px] text-[var(--color-fg-subtle)]">Orderbook bid-ask gap checks</div>
                      </div>
                    </div>
                    <Badge variant="muted" className="font-bold text-[9px] text-[var(--color-bull)] border-[var(--color-bull)]/20 bg-[var(--color-bull-soft)]">
                      {selectedSignal.spreadValidation || "PASSED"}
                    </Badge>
                  </div>

                  {/* Liquidity validation */}
                  <div className="flex items-center justify-between p-2.5 rounded bg-[var(--surface-elevated)] border border-[var(--color-border)] text-xs">
                    <div className="flex items-center gap-2.5">
                      <CheckCircle2 className="size-4 text-[var(--color-bull)]" />
                      <div>
                        <div className="font-semibold text-[var(--color-fg)]">Orderbook Depth Validation</div>
                        <div className="text-[10px] text-[var(--color-fg-subtle)]">Verifying order size impact</div>
                      </div>
                    </div>
                    <Badge variant="muted" className="font-bold text-[9px] text-[var(--color-bull)] border-[var(--color-bull)]/20 bg-[var(--color-bull-soft)]">
                      {selectedSignal.liquidityChecks || "PASSED"}
                    </Badge>
                  </div>

                </CardContent>
              </Card>

            </div>
          )}
        </div>

      </div>
    </PageShell>
  );
}
