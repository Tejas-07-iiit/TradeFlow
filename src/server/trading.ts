"use server";

import { revalidatePath } from "next/cache";
import type {
  CloseReason,
  DecisionSource,
  OrderSide,
  OrderType,
} from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

/**
 * Server actions for the paper-trading engine. The accounting model here is
 * deliberately modelled after Binance USD-M Futures (isolated margin):
 *
 *   walletBalance  — cleared cash. Mutated ONLY on settlement (+ realizedPnL).
 *   usedMargin     — collateral reserved against currently-open positions.
 *   availableBal   — walletBalance − usedMargin  (derived, not stored).
 *   unrealizedPnL  — Σ live mark-to-market across open positions (derived).
 *   totalEquity    — walletBalance + unrealizedPnL (derived).
 *
 * Opening a position reserves margin and creates the row; the wallet balance
 * itself does NOT move (this is what was broken before — opening a SHORT used
 * to credit fake cash, inflating equity).
 *
 * Closing a position is settled exactly ONCE. The atomicity guarantee comes
 * from a conditional `updateMany` keyed on (id, status, quantity) — that is
 * the compare-and-swap that prevents double-settlement when the matching
 * engine, the AI exit watcher, and a manual close all race for the same row.
 */

const LOG_PREFIX = "[trading]";
const DEFAULT_LEVERAGE = 1;

const revalidateTradingPaths = () => {
  revalidatePath("/(platform)", "layout");
};

function statusForReason(reason: CloseReason) {
  switch (reason) {
    case "STOP_LOSS":
      return "STOP_LOSS_HIT" as const;
    case "TAKE_PROFIT":
      return "TAKE_PROFIT_HIT" as const;
    case "EXPIRED":
      return "EXPIRED" as const;
    case "LIQUIDATED":
      return "LIQUIDATED" as const;
    // AI_EXIT and MANUAL both land in the generic CLOSED bucket; the
    // distinction is preserved on TradeHistory.closeReason for analytics.
    default:
      return "CLOSED" as const;
  }
}

function pnlFor(side: OrderSide, qty: number, entry: number, exit: number) {
  const direction = side === "LONG" ? 1 : -1;
  return (exit - entry) * qty * direction;
}

/** Informational only — the simulator does not force-liquidate yet. */
function liquidationPriceFor(
  side: OrderSide,
  entry: number,
  leverage: number,
) {
  if (leverage <= 1) {
    // At 1x there is no liquidation for SHORTs and only at price=0 for LONGs;
    // surfacing 0 is more honest than NaN.
    return side === "LONG" ? 0 : Number.POSITIVE_INFINITY;
  }
  const move = entry / leverage;
  return side === "LONG" ? entry - move : entry + move;
}

export async function createPaperOrder(data: {
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  price?: number;
  takeProfit?: number;
  stopLoss?: number;
  leverage?: number;
  expiresAt?: Date;
  /** Where the decision came from. Defaults to MANUAL for human-initiated flows. */
  decisionSource?: DecisionSource;
  /** Free-form audit text (e.g. LLM model + confidence + setup quality). */
  decisionMeta?: string;
}) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");

  const order = await prisma.paperOrder.create({
    data: {
      userId: session.user.id,
      symbol: data.symbol,
      side: data.side,
      orderType: data.type,
      quantity: data.quantity,
      price: data.price,
      takeProfit: data.takeProfit,
      stopLoss: data.stopLoss,
      expiresAt: data.expiresAt,
      status: "PENDING",
      decisionSource: data.decisionSource ?? "MANUAL",
      decisionMeta: data.decisionMeta,
    },
  });

  revalidateTradingPaths();
  // Never return the raw Prisma row from a server action: its Decimal columns
  // are not serializable across the RSC boundary. Return only the id.
  return { id: order.id };
}

export async function cancelPaperOrder(
  orderId: string,
  reason: "MANUAL" | "EXPIRED" = "MANUAL",
) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");

  // Atomic transition out of PENDING — if another caller already cancelled or
  // filled this order, count will be 0 and we no-op cleanly.
  const result = await prisma.paperOrder.updateMany({
    where: { id: orderId, userId: session.user.id, status: "PENDING" },
    data: { status: reason === "EXPIRED" ? "REJECTED" : "CANCELLED" },
  });
  if (result.count === 0) return { ok: false as const };

  revalidateTradingPaths();
  return { ok: true as const };
}

/**
 * Fill a PENDING order at `fillPrice`. Atomic transition: PENDING → FILLED
 * happens via `updateMany`, so a re-tick by the matching engine cannot fill
 * the same order twice. We then reserve margin and create the position in
 * the same transaction; if margin is insufficient the order rolls back to
 * REJECTED rather than half-filling.
 */
export async function fillPaperOrder(orderId: string, fillPrice: number) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  const userId = session.user.id;

  return prisma.$transaction(async (tx) => {
    // CAS: atomically claim the order. If another tick already filled it the
    // count is 0 and we exit. This is the primary double-fill guard.
    const claim = await tx.paperOrder.updateMany({
      where: { id: orderId, userId, status: "PENDING" },
      data: {
        status: "FILLED",
        filledAt: new Date(),
        filledPrice: fillPrice,
      },
    });
    if (claim.count === 0) return null;

    const order = await tx.paperOrder.findUniqueOrThrow({
      where: { id: orderId },
    });

    const qty = Number(order.quantity);
    const leverage = DEFAULT_LEVERAGE;
    const notional = qty * fillPrice;
    const marginRequired = notional / leverage;

    const wallet = await tx.paperWallet.findUniqueOrThrow({
      where: { userId },
    });
    const walletBalance = Number(wallet.balance);
    const usedMargin = Number(wallet.usedMargin);
    const available = walletBalance - usedMargin;

    if (marginRequired > available + 1e-8) {
      // Roll the order back so the user can see why it didn't fill. We
      // intentionally do NOT throw — this is a *risk-managed* rejection.
      await tx.paperOrder.update({
        where: { id: order.id },
        data: { status: "REJECTED", filledAt: null, filledPrice: null },
      });
      console.warn(
        `${LOG_PREFIX} order ${order.id} rejected — needs $${marginRequired.toFixed(2)} margin, only $${available.toFixed(2)} available`,
      );
      return { rejected: true as const, reason: "insufficient_margin" };
    }

    const liquidationPrice = liquidationPriceFor(
      order.side,
      fillPrice,
      leverage,
    );

    const position = await tx.paperPosition.create({
      data: {
        userId,
        symbol: order.symbol,
        side: order.side,
        initialQuantity: qty,
        quantity: qty,
        entryPrice: fillPrice,
        takeProfit: order.takeProfit,
        stopLoss: order.stopLoss,
        leverage,
        marginUsed: marginRequired,
        liquidationPrice: Number.isFinite(liquidationPrice)
          ? liquidationPrice
          : null,
        walletBalanceSnapshot: walletBalance,
        unrealizedPnl: 0,
        realizedPnl: 0,
        status: "OPEN",
        decisionSource: order.decisionSource,
        decisionMeta: order.decisionMeta,
      },
    });

    await tx.paperWallet.update({
      where: { userId },
      data: { usedMargin: { increment: marginRequired } },
    });

    console.info(
      `${LOG_PREFIX} OPEN ${position.id} ${order.side} ${qty} ${order.symbol} @ ${fillPrice} ` +
        `margin=$${marginRequired.toFixed(2)} (wallet=$${walletBalance.toFixed(2)}, used→$${(usedMargin + marginRequired).toFixed(2)})`,
    );

    revalidateTradingPaths();
    return { positionId: position.id };
  });
}

/**
 * Close a position fully or partially. Settlement is single-shot: the
 * conditional `updateMany` either claims the position (count===1) or aborts
 * (count===0), so callers racing on the same row cannot double-credit
 * realizedPnL.
 *
 * @param exitPrice - mark used for the slice. For TP/SL the matching engine
 *   passes the current tick; for AI exits the LLM trigger price.
 * @param options.quantity - slice size. Omitting (or >= remaining) closes
 *   fully.
 * @param options.reason - drives the terminal status (MANUAL→CLOSED,
 *   STOP_LOSS→STOP_LOSS_HIT, etc.) and is recorded on TradeHistory.
 */
export async function closePaperPosition(
  positionId: string,
  exitPrice: number,
  options: { quantity?: number; reason?: CloseReason } = {},
) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  const userId = session.user.id;
  const reason: CloseReason = options.reason ?? "MANUAL";
  const nowMs = Date.now();

  return prisma.$transaction(async (tx) => {
    // Read inside the transaction so we see the latest committed quantity.
    const position = await tx.paperPosition.findFirst({
      where: {
        id: positionId,
        userId,
        status: { in: ["OPEN", "PARTIALLY_CLOSED"] },
      },
    });
    if (!position) return null;

    const remaining = Number(position.quantity);
    const requested = options.quantity ?? remaining;
    const closeQty = Math.min(Math.max(requested, 0), remaining);
    if (closeQty <= 0) return null;

    const isFullClose = closeQty >= remaining - 1e-12;
    const entry = Number(position.entryPrice);
    const totalMargin = Number(position.marginUsed);
    const priorRealized = Number(position.realizedPnl);

    const slicePnl = pnlFor(position.side, closeQty, entry, exitPrice);
    // Release margin in proportion to the closed quantity. The remaining
    // open quantity keeps its share locked.
    const releasedMargin = isFullClose
      ? totalMargin
      : totalMargin * (closeQty / remaining);
    const remainingMargin = isFullClose ? 0 : totalMargin - releasedMargin;
    const newRealized = priorRealized + slicePnl;

    const durationMs = Math.max(0, nowMs - position.createdAt.getTime());

    let riskReward: number | null = null;
    if (position.stopLoss && position.takeProfit) {
      const sl = Number(position.stopLoss);
      const tp = Number(position.takeProfit);
      const risk = Math.abs(entry - sl);
      const reward = Math.abs(tp - entry);
      riskReward = risk > 0 ? reward / risk : null;
    }

    // CAS: settle exactly once. The (status, quantity) tuple is the row's
    // version — if another caller mutated either, we re-read on retry. Here
    // we just abort: callers already see "no return value" as a no-op.
    const claim = await tx.paperPosition.updateMany({
      where: {
        id: position.id,
        userId,
        status: position.status,
        quantity: position.quantity,
      },
      data: isFullClose
        ? {
            quantity: 0,
            marginUsed: 0,
            status: statusForReason(reason),
            exitPrice,
            unrealizedPnl: 0,
            realizedPnl: newRealized,
            closeReason: reason,
            closedAt: new Date(nowMs),
          }
        : {
            quantity: { decrement: closeQty },
            marginUsed: remainingMargin,
            status: "PARTIALLY_CLOSED",
            realizedPnl: newRealized,
            // unrealizedPnl is a snapshot — recompute for the remaining slice
            // at the exit-price mark so analytics queries on the row are
            // self-consistent.
            unrealizedPnl: pnlFor(
              position.side,
              remaining - closeQty,
              entry,
              exitPrice,
            ),
          },
    });
    if (claim.count === 0) {
      // Another close beat us to it. Silent no-op — TradeHistory + wallet
      // mutation already happened in that other transaction.
      console.info(
        `${LOG_PREFIX} CLOSE ${position.id} skipped — already settled by another caller`,
      );
      return null;
    }

    await tx.tradeHistory.create({
      data: {
        userId,
        positionId: position.id,
        symbol: position.symbol,
        side: position.side,
        quantity: closeQty,
        entryPrice: entry,
        exitPrice,
        pnl: slicePnl,
        closeReason: reason,
        decisionSource: position.decisionSource,
        openedAt: position.createdAt,
        closedAt: new Date(nowMs),
        durationMs,
        riskReward,
      },
    });

    // Single wallet mutation per settlement: release the proportional margin
    // and credit/debit realized PnL once. This is the line the user noticed
    // was firing multiple times under the old code path; the CAS above is
    // what makes it impossible now.
    await tx.paperWallet.update({
      where: { userId },
      data: {
        balance: { increment: slicePnl },
        usedMargin: { decrement: releasedMargin },
      },
    });

    console.info(
      `${LOG_PREFIX} CLOSE ${position.id} ${reason} ${position.side} ${closeQty}/${remaining} ${position.symbol} ` +
        `entry=${entry} exit=${exitPrice} pnl=${slicePnl.toFixed(2)} released=$${releasedMargin.toFixed(2)} ` +
        `(${isFullClose ? "FULL" : "PARTIAL"})`,
    );

    revalidateTradingPaths();
    return { realizedPnl: slicePnl, isFullClose };
  });
}

/**
 * Dev-only: wipe positions/orders/history and reset the wallet to its
 * initial balance with zero usedMargin. Intentionally exposed as a server
 * action so the in-app reset button can call it; the auth check ensures only
 * the signed-in user resets their own state.
 */
export async function resetPaperAccount() {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  const userId = session.user.id;

  await prisma.$transaction(async (tx) => {
    await tx.tradeHistory.deleteMany({ where: { userId } });
    await tx.paperOrder.deleteMany({ where: { userId } });
    await tx.paperPosition.deleteMany({ where: { userId } });
    await tx.paperWallet.update({
      where: { userId },
      data: { balance: 60_000, usedMargin: 0 },
    });
  });

  console.info(`${LOG_PREFIX} RESET account ${userId}`);
  revalidateTradingPaths();
  return { ok: true as const };
}
