"use client";

import { useMemo } from "react";
import { useMarketStore } from "@/store/market-store";
import { usePortfolioStore } from "@/store/portfolio-store";
import type { PaperPositionView } from "@/types/portfolio";

export interface PositionMetrics {
  position: PaperPositionView;
  /** Latest mark from the websocket ticker, or entry if no tick yet. */
  mark: number;
  /** Unrealized PnL on the still-open quantity. */
  unrealizedPnl: number;
  /** unrealizedPnl as a percentage of the position's reserved margin (ROE). */
  unrealizedPnlPct: number;
  /** realizedPnl + unrealizedPnl — the full P&L if closed at mark. */
  totalPnl: number;
  /** Milliseconds since the position was opened. */
  durationMs: number;
  /** |reward| / |risk| from TP and SL relative to entry. Null if either is missing. */
  riskReward: number | null;
}

export interface PortfolioMetrics {
  positions: PositionMetrics[];
  /** Σ live unrealized PnL across the open book. */
  unrealizedPnl: number;
  /** Σ stored realizedPnl on rows passed in (use trade history for the
   *  account-wide running total). */
  realizedPnl: number;
  /** Σ entry × qty across all open positions (gross notional). */
  exposure: number;
  /** Σ marginUsed across the open book — should equal wallet.usedMargin. */
  usedMargin: number;
}

/**
 * Derive live unrealized PnL, duration, and RR for each open position from
 * the websocket ticker store. Memoizes per (positions, tickers) so the
 * consumer only re-renders when those change.
 *
 * Formulae:
 *   LONG unrealized   =  (mark - entry) * qty
 *   SHORT unrealized  =  (entry - mark) * qty
 *   exposure          =  Σ qty * entry  (notional, not net)
 *   ROE per position  =  unrealized / marginUsed
 */
export function usePositionMetrics(positions: PaperPositionView[]): PortfolioMetrics {
  const tickers = useMarketStore((s) => s.tickers);
  const now = Date.now();

  return useMemo(() => {
    let unrealizedPnl = 0;
    let realizedPnl = 0;
    let exposure = 0;
    let usedMargin = 0;

    const enriched: PositionMetrics[] = positions.map((p) => {
      const mark = tickers[p.symbol]?.last ?? p.entryPrice;
      const direction = p.side === "LONG" ? 1 : -1;
      const u = (mark - p.entryPrice) * p.quantity * direction;
      unrealizedPnl += u;
      realizedPnl += p.realizedPnl;
      exposure += p.entryPrice * p.quantity;
      usedMargin += p.marginUsed;

      const pnlPct = p.marginUsed > 0 ? (u / p.marginUsed) * 100 : 0;

      let riskReward: number | null = null;
      if (p.takeProfit != null && p.stopLoss != null) {
        const risk = Math.abs(p.entryPrice - p.stopLoss);
        const reward = Math.abs(p.takeProfit - p.entryPrice);
        riskReward = risk > 0 ? reward / risk : null;
      }

      const openedAt = new Date(p.createdAt).getTime();
      return {
        position: p,
        mark,
        unrealizedPnl: u,
        unrealizedPnlPct: pnlPct,
        totalPnl: u + p.realizedPnl,
        durationMs: Math.max(0, now - openedAt),
        riskReward,
      };
    });

    return {
      positions: enriched,
      unrealizedPnl,
      realizedPnl,
      exposure,
      usedMargin,
    };
    // `now` is intentionally excluded — the hook re-runs on every market tick
    // (tickers ref change), which is more frequent than the ~1s wall clock
    // and avoids re-rendering between ticks just for a slowly-ticking clock.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positions, tickers]);
}

/**
 * Account-level view of the wallet + the live open book. Centralises the
 * five separate accounting numbers the UI is supposed to show:
 *
 *   walletBalance — pure cleared cash (from the wallet row).
 *   usedMargin    — collateral locked against open positions.
 *   unrealizedPnl — Σ live mark-to-market on open positions.
 *   totalEquity   — walletBalance + unrealizedPnl. The "if I closed every
 *                   position right now" number.
 *   availableBal  — walletBalance − usedMargin. What's free to open new
 *                   positions with.
 *   realizedPnl   — running total across closed trade history.
 */
export interface AccountMetrics {
  walletBalance: number;
  usedMargin: number;
  unrealizedPnl: number;
  totalEquity: number;
  availableBalance: number;
  realizedPnl: number;
  currency: string;
}

export function useAccountMetrics(): AccountMetrics {
  const walletBalance = usePortfolioStore((s) => s.walletBalance);
  const usedMargin = usePortfolioStore((s) => s.usedMargin);
  const currency = usePortfolioStore((s) => s.currency);
  const positions = usePortfolioStore((s) => s.positions);
  const tradeHistory = usePortfolioStore((s) => s.tradeHistory);

  const { unrealizedPnl } = usePositionMetrics(positions);

  return useMemo(() => {
    const realizedPnl = tradeHistory.reduce((sum, t) => sum + t.pnl, 0);
    return {
      walletBalance,
      usedMargin,
      unrealizedPnl,
      totalEquity: walletBalance + unrealizedPnl,
      availableBalance: walletBalance - usedMargin,
      realizedPnl,
      currency,
    };
  }, [walletBalance, usedMargin, unrealizedPnl, tradeHistory, currency]);
}

export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) {
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor((ms % 86_400_000) / 3_600_000);
  return h ? `${d}d ${h}h` : `${d}d`;
}
