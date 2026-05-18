"use server";

import { revalidatePath } from "next/cache";
import type { OrderSide, OrderType } from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function createPaperOrder(data: {
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  price?: number;
  takeProfit?: number;
  stopLoss?: number;
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
      status: "PENDING",
    },
  });

  revalidatePath("/paper-trading");
  revalidatePath("/dashboard");
  return order;
}

export async function cancelPaperOrder(orderId: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");

  const order = await prisma.paperOrder.update({
    where: { id: orderId, userId: session.user.id },
    data: { status: "CANCELLED" },
  });

  revalidatePath("/paper-trading");
  return order;
}

export async function fillPaperOrder(orderId: string, fillPrice: number) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");

  const order = await prisma.paperOrder.findUnique({
    where: { id: orderId, userId: session.user.id },
  });

  if (!order || order.status !== "PENDING") return;

  const totalCost = Number(order.quantity) * fillPrice;

  await prisma.$transaction(async (tx) => {
    // 1. Update order status
    await tx.paperOrder.update({
      where: { id: orderId },
      data: { status: "FILLED", filledAt: new Date(), price: fillPrice },
    });

    // 2. Create position
    await tx.paperPosition.create({
      data: {
        userId: session.user.id,
        symbol: order.symbol,
        side: order.side,
        quantity: order.quantity,
        entryPrice: fillPrice,
        takeProfit: order.takeProfit,
        stopLoss: order.stopLoss,
        status: "OPEN",
      },
    });

    // 3. Adjust wallet balance
    if (order.side === "LONG") {
      await tx.paperWallet.update({
        where: { userId: session.user.id },
        data: { balance: { decrement: totalCost } },
      });
    } else {
      await tx.paperWallet.update({
        where: { userId: session.user.id },
        data: { balance: { increment: totalCost } },
      });
    }
  });

  revalidatePath("/paper-trading");
  revalidatePath("/portfolio");
  revalidatePath("/dashboard");
}

export async function closePaperPosition(positionId: string, exitPrice: number) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");

  const position = await prisma.paperPosition.findUnique({
    where: { id: positionId, userId: session.user.id },
  });

  if (!position || position.status !== "OPEN") return;

  const direction = position.side === "LONG" ? 1 : -1;
  const pnl = (exitPrice - Number(position.entryPrice)) * Number(position.quantity) * direction;
  const returnCapital = Number(position.quantity) * exitPrice;

  await prisma.$transaction(async (tx) => {
    // 1. Close position
    await tx.paperPosition.update({
      where: { id: positionId },
      data: {
        status: "CLOSED",
        exitPrice,
        pnl,
        closedAt: new Date(),
      },
    });

    // 2. Return capital / adjust wallet
    if (position.side === "LONG") {
      await tx.paperWallet.update({
        where: { userId: session.user.id },
        data: { balance: { increment: returnCapital } },
      });
    } else {
      await tx.paperWallet.update({
        where: { userId: session.user.id },
        data: { balance: { decrement: returnCapital } },
      });
    }
  });

  revalidatePath("/paper-trading");
  revalidatePath("/portfolio");
  revalidatePath("/dashboard");
}
