import { LivePortfolioPage } from "@/features/portfolio/live-portfolio-page";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { PaperPositionView } from "@/types/portfolio";

export const dynamic = "force-dynamic";

export default async function PortfolioPage() {
  const session = await auth();
  const userId = session?.user?.id;

  const [wallet, positions] = userId
    ? await Promise.all([
        prisma.paperWallet.findUnique({ where: { userId } }),
        prisma.paperPosition.findMany({
          where: { userId, status: { in: ["OPEN", "PARTIALLY_CLOSED"] } },
          orderBy: { createdAt: "desc" },
        }),
      ])
    : [null, []];

  return (
    <LivePortfolioPage
      walletBalance={Number(wallet?.balance ?? 60_000)}
      usedMargin={Number(wallet?.usedMargin ?? 0)}
      positions={positions.map(
        (position): PaperPositionView => ({
          id: position.id,
          symbol: position.symbol,
          side: position.side,
          quantity: Number(position.quantity),
          initialQuantity: Number(position.initialQuantity),
          entryPrice: Number(position.entryPrice),
          exitPrice: position.exitPrice ? Number(position.exitPrice) : null,
          takeProfit: position.takeProfit ? Number(position.takeProfit) : null,
          stopLoss: position.stopLoss ? Number(position.stopLoss) : null,
          leverage: position.leverage,
          marginUsed: Number(position.marginUsed),
          liquidationPrice: position.liquidationPrice
            ? Number(position.liquidationPrice)
            : null,
          walletBalanceSnapshot: position.walletBalanceSnapshot
            ? Number(position.walletBalanceSnapshot)
            : null,
          realizedPnl: Number(position.realizedPnl),
          unrealizedPnl: Number(position.unrealizedPnl),
          totalFees: Number(position.totalFees),
          status: position.status,
          closeReason: position.closeReason,
          decisionSource: position.decisionSource,
          decisionMeta: position.decisionMeta,
          createdAt: position.createdAt.toISOString(),
          closedAt: position.closedAt ? position.closedAt.toISOString() : null,
        }),
      )}
    />
  );
}
