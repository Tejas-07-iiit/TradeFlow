import { LivePaperTradingPage } from "@/features/trading/live-paper-trading-page";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { PaperOrderView, PaperPositionView } from "@/types/portfolio";

export const dynamic = "force-dynamic";

export default async function PaperTradingPage() {
  const session = await auth();
  const userId = session?.user?.id;

  const [wallet, positions, orders] = userId
    ? await Promise.all([
        prisma.paperWallet.findUnique({ where: { userId } }),
        prisma.paperPosition.findMany({
          where: { userId, status: "OPEN" },
          orderBy: { createdAt: "desc" },
        }),
        prisma.paperOrder.findMany({
          where: { userId },
          orderBy: { createdAt: "desc" },
          take: 12,
        }),
      ])
    : [null, [], []];

  return (
    <LivePaperTradingPage />
  );
}
