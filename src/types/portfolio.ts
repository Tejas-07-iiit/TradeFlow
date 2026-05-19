export type PositionStatusView =
  | "OPEN"
  | "PARTIALLY_CLOSED"
  | "CLOSED"
  | "STOP_LOSS_HIT"
  | "TAKE_PROFIT_HIT"
  | "EXPIRED"
  | "LIQUIDATED";

export type CloseReasonView =
  | "MANUAL"
  | "STOP_LOSS"
  | "TAKE_PROFIT"
  | "EXPIRED"
  | "LIQUIDATED"
  | "AI_EXIT";

export type OrderStatusView = "PENDING" | "FILLED" | "CANCELLED" | "REJECTED";

export type DecisionSourceView = "MANUAL" | "RULE" | "LLM";

export type PaperPositionView = {
  id: string;
  symbol: string;
  side: "LONG" | "SHORT";
  quantity: number;
  initialQuantity: number;
  entryPrice: number;
  exitPrice?: number | null;
  takeProfit?: number | null;
  stopLoss?: number | null;
  leverage: number;
  marginUsed: number;
  liquidationPrice?: number | null;
  walletBalanceSnapshot?: number | null;
  realizedPnl: number;
  unrealizedPnl: number;
  totalFees: number;
  status: PositionStatusView;
  closeReason?: CloseReasonView | null;
  decisionSource: DecisionSourceView;
  decisionMeta?: string | null;
  createdAt: string;
  closedAt?: string | null;
};

export type PaperWalletView = {
  walletBalance: number;
  usedMargin: number;
  currency: string;
};

export type PaperOrderView = {
  id: string;
  symbol: string;
  side: "LONG" | "SHORT";
  orderType: string;
  quantity: number;
  price: number | null;
  filledPrice?: number | null;
  takeProfit?: number | null;
  stopLoss?: number | null;
  status: OrderStatusView;
  decisionSource: DecisionSourceView;
  decisionMeta?: string | null;
  createdAt?: string;
  filledAt?: string | null;
  expiresAt?: string | null;
};

export type TradeHistoryView = {
  id: string;
  positionId: string;
  symbol: string;
  side: "LONG" | "SHORT";
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  closeReason: CloseReasonView;
  decisionSource: DecisionSourceView;
  openedAt: string;
  closedAt: string;
  durationMs: number;
  riskReward: number | null;
};
