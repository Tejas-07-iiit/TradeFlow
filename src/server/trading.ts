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
import { DEFAULT_WALLET_BALANCE } from "./wallet";
import { computePositionRiskMetrics } from "@/lib/risk/metrics";

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
  // `revalidatePath` requires a request context (the "static generation
  // store"). The background matching loop / scheduled jobs call these helpers
  // outside any request, so the call throws `Invariant: static generation
  // store missing`. Cache invalidation is best-effort — swallowing here is
  // safe; the UI polls on its own interval.
  try {
    revalidatePath("/(platform)", "layout");
  } catch {
    // background context — no client to invalidate
  }
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
  const metrics = computePositionRiskMetrics({
    side,
    entryPrice: entry,
    quantity: qty,
    leverage: 1,
    currentPrice: exit,
  });
  return metrics.unrealizedPnl;
}

/** Informational only — the simulator does not force-liquidate yet. */
function liquidationPriceFor(
  side: OrderSide,
  entry: number,
  leverage: number,
) {
  const metrics = computePositionRiskMetrics({
    side,
    entryPrice: entry,
    quantity: 1,
    leverage,
  });
  return metrics.liquidationPrice ?? (side === "LONG" ? 0 : Number.POSITIVE_INFINITY);
}

export async function createPaperOrderInternal(userId: string, data: {
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  price?: number;
  takeProfit?: number;
  stopLoss?: number;
  leverage?: number;
  expiresAt?: Date;
  decisionSource?: DecisionSource;
  decisionMeta?: string;
  blockIfAlreadyOpen?: boolean;
}) {
  if (data.blockIfAlreadyOpen) {
    const [openPos, pendingOrder] = await Promise.all([
      prisma.paperPosition.findFirst({
        where: {
          userId,
          symbol: data.symbol,
          status: { in: ["OPEN", "PARTIALLY_CLOSED"] },
        },
        select: { id: true, side: true, decisionSource: true },
      }),
      prisma.paperOrder.findFirst({
        where: { userId, symbol: data.symbol, status: "PENDING" },
        select: { id: true },
      }),
    ]);
    if (openPos) {
      throw new Error(
        `[trading] duplicate blocked: ${data.symbol} already has open ${openPos.side} (${openPos.decisionSource})`,
      );
    }
    if (pendingOrder) {
      throw new Error(
        `[trading] duplicate blocked: ${data.symbol} already has a pending order`,
      );
    }
  }

  const order = await prisma.paperOrder.create({
    data: {
      userId,
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
  return { id: order.id };
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
  decisionSource?: DecisionSource;
  decisionMeta?: string;
  blockIfAlreadyOpen?: boolean;
}) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return createPaperOrderInternal(session.user.id, data);
}

export async function cancelPaperOrderInternal(
  userId: string,
  orderId: string,
  reason: "MANUAL" | "EXPIRED" = "MANUAL",
) {
  const result = await prisma.paperOrder.updateMany({
    where: { id: orderId, userId, status: "PENDING" },
    data: { status: reason === "EXPIRED" ? "REJECTED" : "CANCELLED" },
  });
  if (result.count === 0) return { ok: false as const };

  revalidateTradingPaths();
  return { ok: true as const };
}

export async function cancelPaperOrder(
  orderId: string,
  reason: "MANUAL" | "EXPIRED" = "MANUAL",
) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return cancelPaperOrderInternal(session.user.id, orderId, reason);
}

export async function fillPaperOrderInternal(userId: string, orderId: string, fillPrice: number) {
  const result = await prisma.$transaction(async (tx) => {
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
        originalTakeProfit: order.takeProfit,
        originalStopLoss: order.stopLoss,
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

    return { positionId: position.id };
  });
  revalidateTradingPaths();
  return result;
}

export async function fillPaperOrder(orderId: string, fillPrice: number) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return fillPaperOrderInternal(session.user.id, orderId, fillPrice);
}

export async function closePaperPositionInternal(
  userId: string,
  positionId: string,
  exitPrice: number,
  options: { quantity?: number; reason?: CloseReason; closedAt?: number } = {},
) {
  const reason: CloseReason = options.reason ?? "MANUAL";
  const nowMs = options.closedAt ?? Date.now();

  const result = await prisma.$transaction(async (tx) => {
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
    const releasedMargin = isFullClose
      ? totalMargin
      : totalMargin * (closeQty / remaining);
    const remainingMargin = isFullClose ? 0 : totalMargin - releasedMargin;
    const newRealized = priorRealized + slicePnl;

    const durationMs = Math.max(0, nowMs - position.createdAt.getTime());

    let riskReward: number | null = null;
    if (position.stopLoss && position.takeProfit) {
      const metrics = computePositionRiskMetrics({
        side: position.side,
        entryPrice: entry,
        quantity: closeQty,
        leverage: position.leverage,
        takeProfitPrice: Number(position.takeProfit),
        stopLossPrice: Number(position.stopLoss),
      });
      riskReward = metrics.riskRewardRatio > 0 ? metrics.riskRewardRatio : null;
    }

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
            unrealizedPnl: pnlFor(
              position.side,
              remaining - closeQty,
              entry,
              exitPrice,
            ),
          },
    });
    if (claim.count === 0) {
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

    return { realizedPnl: slicePnl, isFullClose };
  });
  revalidateTradingPaths();
  return result;
}

export async function closePaperPosition(
  positionId: string,
  exitPrice: number,
  options: { quantity?: number; reason?: CloseReason; closedAt?: number } = {},
) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return closePaperPositionInternal(session.user.id, positionId, exitPrice, options);
}

export async function resetPaperAccountInternal(userId: string) {
  await prisma.$transaction(async (tx) => {
    await tx.tradeHistory.deleteMany({ where: { userId } });
    await tx.paperOrder.deleteMany({ where: { userId } });
    await tx.paperPosition.deleteMany({ where: { userId } });
    await tx.paperWallet.update({
      where: { userId },
      data: { balance: DEFAULT_WALLET_BALANCE, usedMargin: 0 },
    });
  });

  console.info(`${LOG_PREFIX} RESET account ${userId}`);
  revalidateTradingPaths();
  return { ok: true as const };
}

export async function resetPaperAccount() {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return resetPaperAccountInternal(session.user.id);
}

export async function updatePositionLevelsInternal(
  userId: string,
  positionId: string,
  data: {
    takeProfit: number | null;
    stopLoss: number | null;
    currentTakeProfit: number | null;
    currentStopLoss: number | null;
    managementMeta?: any;
    healthScore?: number;
  }
) {
  const outcome = await prisma.$transaction(async (tx) => {
    const position = await tx.paperPosition.findFirst({
      where: {
        id: positionId,
        userId,
        status: { in: ["OPEN", "PARTIALLY_CLOSED"] },
      },
    });

    if (!position) {
      console.warn(`[TRADE-MGMT] Position ${positionId} not found or not open for updatePositionLevels`);
      return null;
    }

    const side = position.side;
    const currentSL = position.stopLoss ? Number(position.stopLoss) : null;
    const currentTP = position.takeProfit ? Number(position.takeProfit) : null;

    if (data.currentStopLoss !== undefined && data.currentStopLoss !== currentSL) {
      console.warn(`[TRADE-MGMT] CAS mismatch for SL on ${positionId}: expected ${data.currentStopLoss}, db has ${currentSL}`);
      return null;
    }
    if (data.currentTakeProfit !== undefined && data.currentTakeProfit !== currentTP) {
      console.warn(`[TRADE-MGMT] CAS mismatch for TP on ${positionId}: expected ${data.currentTakeProfit}, db has ${currentTP}`);
      return null;
    }

    if (data.stopLoss !== undefined && data.stopLoss !== null) {
      if (currentSL !== null) {
        if (side === "LONG" && data.stopLoss < currentSL) {
          console.warn(`[TRADE-MGMT] Rejecting SL widening for LONG position ${positionId}: new ${data.stopLoss} < current ${currentSL}`);
          return null;
        }
        if (side === "SHORT" && data.stopLoss > currentSL) {
          console.warn(`[TRADE-MGMT] Rejecting SL widening for SHORT position ${positionId}: new ${data.stopLoss} > current ${currentSL}`);
          return null;
        }
      }
    }

    const updateQuery: any = {
      id: positionId,
      userId,
      status: position.status,
    };
    if (currentSL !== null) updateQuery.stopLoss = position.stopLoss;
    if (currentTP !== null) updateQuery.takeProfit = position.takeProfit;

    const updateData: any = {
      takeProfit: data.takeProfit,
      stopLoss: data.stopLoss,
    };
    if (data.managementMeta !== undefined) {
      updateData.managementMeta = data.managementMeta;
    }
    if (data.healthScore !== undefined) {
      updateData.tradeHealthScore = data.healthScore;
    }

    const result = await tx.paperPosition.updateMany({
      where: updateQuery,
      data: updateData,
    });

    if (result.count === 0) {
      console.warn(`[TRADE-MGMT] CAS update failed for ${positionId}`);
      return null;
    }

    console.info(
      `[TRADE-MGMT] UPDATED ${positionId} levels: TP ${currentTP}→${data.takeProfit}, SL ${currentSL}→${data.stopLoss}`
    );

    return { ok: true };
  });
  if (outcome?.ok) revalidateTradingPaths();
  return outcome;
}

export async function updatePositionLevels(
  positionId: string,
  data: {
    takeProfit: number | null;
    stopLoss: number | null;
    currentTakeProfit: number | null;
    currentStopLoss: number | null;
    managementMeta?: any;
    healthScore?: number;
  }
) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return updatePositionLevelsInternal(session.user.id, positionId, data);
}

export async function updatePositionHealthScoreInternal(
  userId: string,
  positionId: string,
  healthScore: number,
  managementMeta?: any
) {
  const updateData: any = {
    tradeHealthScore: healthScore,
  };
  if (managementMeta !== undefined) {
    updateData.managementMeta = managementMeta;
  }

  const result = await prisma.paperPosition.updateMany({
    where: {
      id: positionId,
      userId,
      status: { in: ["OPEN", "PARTIALLY_CLOSED"] },
    },
    data: updateData,
  });

  if (result.count > 0) {
    revalidateTradingPaths();
  }

  return { ok: result.count > 0 };
}

export async function updatePositionHealthScore(
  positionId: string,
  healthScore: number,
  managementMeta?: any
) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return updatePositionHealthScoreInternal(session.user.id, positionId, healthScore, managementMeta);
}

export async function createManagementEventInternal(data: {
  positionId: string;
  type: string;
  oldValue?: number | null;
  newValue?: number | null;
  healthScore: number;
  confidence: number;
  reason: string;
  indicators?: any;
}) {
  const event = await prisma.tradeManagementEvent.create({
    data: {
      positionId: data.positionId,
      type: data.type,
      oldValue: data.oldValue,
      newValue: data.newValue,
      healthScore: data.healthScore,
      confidence: data.confidence,
      reason: data.reason,
      indicators: data.indicators || {},
    },
  });

  revalidateTradingPaths();
  return { id: event.id };
}

export async function createManagementEvent(data: {
  positionId: string;
  type: string;
  oldValue?: number | null;
  newValue?: number | null;
  healthScore: number;
  confidence: number;
  reason: string;
  indicators?: any;
}) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return createManagementEventInternal(data);
}
