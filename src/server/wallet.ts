import type { Prisma, PrismaClient } from "@prisma/client";

import { prisma } from "@/lib/prisma";

export const DEFAULT_WALLET_BALANCE = 10_000;
export const DEFAULT_WALLET_CURRENCY = "USDT";

/**
 * Create a paper wallet for a user with the default virtual balance.
 * Idempotent: returns the existing wallet if one already exists.
 */
export async function ensurePaperWallet(
  userId: string,
  tx?: Prisma.TransactionClient | PrismaClient,
) {
  const client = tx ?? prisma;
  return client.paperWallet.upsert({
    where: { userId },
    update: {},
    create: {
      userId,
      balance: DEFAULT_WALLET_BALANCE,
      currency: DEFAULT_WALLET_CURRENCY,
    },
  });
}
