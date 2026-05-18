"use client";

import { create } from "zustand";
import type { PaperOrderView, PaperPositionView } from "@/types/portfolio";

interface PortfolioState {
  balance: number;
  currency: string;
  positions: PaperPositionView[];
  orders: PaperOrderView[];
  
  setPortfolio: (data: {
    balance: number;
    currency: string;
    positions: PaperPositionView[];
    orders: PaperOrderView[];
  }) => void;
  
  updateBalance: (balance: number) => void;
  addOrder: (order: PaperOrderView) => void;
  removeOrder: (orderId: string) => void;
  addPosition: (position: PaperPositionView) => void;
  closePosition: (positionId: string) => void;
}

export const usePortfolioStore = create<PortfolioState>((set) => ({
  balance: 0,
  currency: "USDT",
  positions: [],
  orders: [],

  setPortfolio: (data) => set(data),
  
  updateBalance: (balance) => set({ balance }),
  
  addOrder: (order) => set((state) => ({ 
    orders: [order, ...state.orders].slice(0, 100) 
  })),
  
  removeOrder: (orderId) => set((state) => ({
    orders: state.orders.filter(o => o.id !== orderId)
  })),
  
  addPosition: (position) => set((state) => ({
    positions: [position, ...state.positions]
  })),
  
  closePosition: (positionId) => set((state) => ({
    positions: state.positions.filter(p => p.id !== positionId)
  })),
}));
