import { redirect } from "next/navigation";

import { MarketDataProvider } from "@/components/providers/market-data-provider";
import { MatchingEngineSubscriber } from "@/components/providers/matching-engine-provider";
import { Sidebar } from "@/features/dashboard/sidebar";
import { Topbar } from "@/features/dashboard/topbar";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ensurePaperWallet } from "@/server/wallet";

import { PortfolioProvider } from "@/components/providers/portfolio-provider";

export const dynamic = "force-dynamic";

export default async function PlatformLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  if (!session?.user?.id) {
    redirect("/login");
  }

  const userId = session.user.id;

  const [wallet, positions, orders] = await Promise.all([
    ensurePaperWallet(userId),
    prisma.paperPosition.findMany({
      where: { userId, status: "OPEN" },
    }),
    prisma.paperOrder.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
  ]);

  const balance = Number(wallet.balance);
  const currency = wallet.currency;

  const positionsView: any[] = positions.map((p) => ({
    id: p.id,
    symbol: p.symbol,
    side: p.side,
    quantity: Number(p.quantity),
    entryPrice: Number(p.entryPrice),
    pnl: Number(p.pnl),
    status: p.status,
    createdAt: p.createdAt.toISOString(),
  }));

  const ordersView: any[] = orders.map((o) => ({
    id: o.id,
    symbol: o.symbol,
    side: o.side,
    orderType: o.orderType,
    quantity: Number(o.quantity),
    price: o.price ? Number(o.price) : null,
    status: o.status,
    createdAt: o.createdAt.toISOString(),
    filledAt: o.filledAt ? o.filledAt.toISOString() : null,
  }));

  const pendingOrders = ordersView.filter(o => o.status === "PENDING");

  return (
    <div className="min-h-screen bg-[var(--color-bg)] text-[var(--color-fg)]">
      <div className="flex min-h-screen">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <MarketDataProvider>
            <PortfolioProvider
              balance={balance}
              currency={currency}
              positions={positionsView}
              orders={ordersView}
            >
              <MatchingEngineSubscriber />
              <Topbar />
              <main className="flex-1 p-4 lg:p-5">{children}</main>
            </PortfolioProvider>
          </MarketDataProvider>
        </div>
      </div>
    </div>
  );
}
