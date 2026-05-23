import type { OrderSide } from "@prisma/client";

export interface PositionRiskInput {
  side: "LONG" | "SHORT" | OrderSide;
  entryPrice: number;
  quantity: number;
  leverage: number;
  takeProfitPrice?: number | null;
  stopLossPrice?: number | null;
  currentPrice?: number | null;
  walletBalance?: number | null;
}

export interface PositionRiskMetrics {
  /** Gross notional exposure in quote asset (quantity * entryPrice) */
  notionalValue: number;
  /** Reserved collateral in quote asset (notionalValue / leverage) */
  marginUsed: number;
  
  /** Expected profit at current TP level (takeProfitPrice) */
  projectedProfit: number;
  /** Expected loss at current SL level (stopLossPrice) */
  projectedLoss: number;
  /** Projected Risk-Reward Ratio (projectedProfit / projectedLoss) */
  riskRewardRatio: number;

  /** Real-time mark-to-market unrealized PnL */
  unrealizedPnl: number;
  /** Return on Equity (unrealizedPnl / marginUsed * 100) */
  unrealizedPnlPct: number;
  /** Return on Notional (unrealizedPnl / notionalValue * 100) */
  unrealizedPnlNotionalPct: number;

  /** Current stop-loss risk as a percentage of total wallet balance */
  riskPercentOfWallet: number | null;

  /** Price level at which the position is subject to liquidation */
  liquidationPrice: number | null;
}

/**
 * The single, canonical calculation engine for position risk.
 *
 * ALL components (UI, execution engine, AI reasoners, database writers, telemetry,
 * scorecards, and overlays) MUST route their calculations through this function
 * to guarantee mathematical consistency across the system.
 */
export function computePositionRiskMetrics(input: PositionRiskInput): PositionRiskMetrics {
  const side = input.side;
  const entryPrice = Number(input.entryPrice);
  const quantity = Number(input.quantity);
  const leverage = Math.max(1, Number(input.leverage) || 1);
  
  const tp = input.takeProfitPrice != null && Number.isFinite(input.takeProfitPrice)
    ? Number(input.takeProfitPrice)
    : null;
  const sl = input.stopLossPrice != null && Number.isFinite(input.stopLossPrice)
    ? Number(input.stopLossPrice)
    : null;
  const current = input.currentPrice != null && Number.isFinite(input.currentPrice)
    ? Number(input.currentPrice)
    : null;
  const balance = input.walletBalance != null && Number.isFinite(input.walletBalance)
    ? Number(input.walletBalance)
    : null;

  // 1. Exposure and Margin
  const notionalValue = entryPrice * quantity;
  const marginUsed = notionalValue / leverage;

  // 2. TP / SL Projections
  let projectedProfit = 0;
  let projectedLoss = 0;

  if (tp !== null && tp > 0) {
    projectedProfit = side === "LONG"
      ? (tp - entryPrice) * quantity
      : (entryPrice - tp) * quantity;
  }

  if (sl !== null && sl > 0) {
    projectedLoss = side === "LONG"
      ? (entryPrice - sl) * quantity
      : (sl - entryPrice) * quantity;
  }

  const riskRewardRatio = projectedLoss > 0 ? projectedProfit / projectedLoss : 0;

  // 3. Mark-to-market Unrealized Metrics
  let unrealizedPnl = 0;
  let unrealizedPnlPct = 0;
  let unrealizedPnlNotionalPct = 0;

  if (current !== null && current > 0) {
    unrealizedPnl = side === "LONG"
      ? (current - entryPrice) * quantity
      : (entryPrice - current) * quantity;

    unrealizedPnlPct = marginUsed > 0 ? (unrealizedPnl / marginUsed) * 100 : 0;
    unrealizedPnlNotionalPct = notionalValue > 0 ? (unrealizedPnl / notionalValue) * 100 : 0;
  }

  // 4. Wallet Risk Percentage
  const riskPercentOfWallet = (balance !== null && balance > 0 && projectedLoss > 0)
    ? (projectedLoss / balance) * 100
    : null;

  // 5. Liquidation Price (isolated margin Isolated-style approximation)
  let liquidationPrice: number | null = null;
  if (leverage > 1) {
    const move = entryPrice / leverage;
    liquidationPrice = side === "LONG" ? entryPrice - move : entryPrice + move;
  } else {
    liquidationPrice = side === "LONG" ? 0 : Number.POSITIVE_INFINITY;
  }

  return {
    notionalValue,
    marginUsed,
    projectedProfit,
    projectedLoss,
    riskRewardRatio,
    unrealizedPnl,
    unrealizedPnlPct,
    unrealizedPnlNotionalPct,
    riskPercentOfWallet,
    liquidationPrice,
  };
}
