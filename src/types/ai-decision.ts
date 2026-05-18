export type DecisionSignal = "BUY" | "SELL" | "HOLD";
export type RiskLevel = "Low" | "Medium" | "High";
export type MarketCondition =
  | "Trending"
  | "Choppy"
  | "Breakout"
  | "Compression"
  | "High Volatility"
  | "Reversal Zone"
  | "Trending Up"
  | "Trending Down"
  | "Sideways";

export type SignalType =
  | "BREAKOUT LONG"
  | "BREAKDOWN SHORT"
  | "PULLBACK LONG"
  | "REVERSAL LONG"
  | "SCALP LONG"
  | "MOMENTUM SHORT"
  | "MOMENTUM LONG"
  | "RANGE TRADE"
  | "NONE";

export type SignalStatus = "NEW" | "ACTIVE" | "EXPIRED" | "INVALIDATED" | "COMPLETED";

export interface AIDecision {
  symbol: string;
  signal: DecisionSignal;
  type: SignalType;
  status: SignalStatus;
  /** 0–100 */
  confidence: number;
  risk: RiskLevel;
  marketCondition: MarketCondition;
  entryPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  rrRatio?: number;
  setupQuality: "A+" | "A" | "B" | "C";
  expectedHoldTime: string;
  reasons: string[];
  warnings: string[];
  verdict: string;
  /** ISO timestamp */
  generatedAt: string;
  expiresAt: string;
}
