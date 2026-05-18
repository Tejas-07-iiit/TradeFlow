export type PaperPositionView = {
  id: string;
  symbol: string;
  side: "LONG" | "SHORT";
  quantity: number;
  entryPrice: number;
  exitPrice?: number | null;
  takeProfit?: number | null;
  stopLoss?: number | null;
  pnl: number;
  status: string;
  createdAt?: string;
  closedAt?: string;
};

export type PaperOrderView = {
  id: string;
  symbol: string;
  side: "LONG" | "SHORT";
  orderType: string;
  quantity: number;
  price: number | null;
  takeProfit?: number | null;
  stopLoss?: number | null;
  status: string;
  createdAt?: string;
  filledAt?: string | null;
};
