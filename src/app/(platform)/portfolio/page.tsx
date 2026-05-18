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
          where: { userId, status: "OPEN" },
          orderBy: { createdAt: "desc" },
        }),
      ])
    : [null, []];

  return (
    <LivePortfolioPage
      balance={Number(wallet?.balance ?? 10_000)}
      positions={positions.map(
        (position): PaperPositionView => ({
          id: position.id,
          symbol: position.symbol,
          side: position.side,
          quantity: Number(position.quantity),
          entryPrice: Number(position.entryPrice),
          pnl: Number(position.pnl),
          status: position.status,
        }),
      )}
    />
  );
}
