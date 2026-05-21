"use server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { TradeManagementEventView, ManagementEventType } from "@/types/trade-management";

export async function getManagementEvents(positionId: string): Promise<TradeManagementEventView[]> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");

  const events = await prisma.tradeManagementEvent.findMany({
    where: {
      positionId,
      position: { userId: session.user.id }
    },
    orderBy: { createdAt: "desc" },
  });

  return events.map((e) => ({
    id: e.id,
    type: e.type as ManagementEventType,
    oldValue: e.oldValue,
    newValue: e.newValue,
    healthScore: e.healthScore,
    confidence: e.confidence,
    reason: e.reason,
    indicators: e.indicators as Record<string, unknown> | null,
    createdAt: e.createdAt.toISOString(),
  }));
}

export async function getPositionManagementSummary(positionId: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");

  const position = await prisma.paperPosition.findFirst({
    where: {
      id: positionId,
      userId: session.user.id,
    },
    include: {
      managementEvents: {
        orderBy: { createdAt: "desc" },
      },
    },
  });

  if (!position) return null;

  return {
    id: position.id,
    symbol: position.symbol,
    side: position.side,
    entryPrice: Number(position.entryPrice),
    quantity: Number(position.quantity),
    initialQuantity: Number(position.initialQuantity),
    takeProfit: position.takeProfit ? Number(position.takeProfit) : null,
    stopLoss: position.stopLoss ? Number(position.stopLoss) : null,
    originalTakeProfit: position.originalTakeProfit ? Number(position.originalTakeProfit) : null,
    originalStopLoss: position.originalStopLoss ? Number(position.originalStopLoss) : null,
    tradeHealthScore: position.tradeHealthScore,
    managementMeta: position.managementMeta,
    createdAt: position.createdAt.toISOString(),
    closedAt: position.closedAt?.toISOString() || null,
    status: position.status,
    closeReason: position.closeReason,
    managementEvents: position.managementEvents.map((e) => ({
      id: e.id,
      type: e.type as ManagementEventType,
      oldValue: e.oldValue,
      newValue: e.newValue,
      healthScore: e.healthScore,
      confidence: e.confidence,
      reason: e.reason,
      indicators: e.indicators as Record<string, unknown> | null,
      createdAt: e.createdAt.toISOString(),
    })),
  };
}
