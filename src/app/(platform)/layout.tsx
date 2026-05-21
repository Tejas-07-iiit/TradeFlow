import { redirect } from "next/navigation";

import { AiDecisionSubscriber } from "@/components/providers/ai-decision-subscriber";
import { AiExecutionEngine } from "@/components/providers/ai-execution-engine";
import { AiSignalEngine } from "@/components/providers/ai-signal-engine";
import { AiThesisSubscriber } from "@/components/providers/ai-thesis-subscriber";
import { NewsSubscriber } from "@/components/providers/news-subscriber";
import { MarketDataProvider } from "@/components/providers/market-data-provider";
import { MatchingEngineSubscriber } from "@/components/providers/matching-engine-provider";
import { PortfolioProvider } from "@/components/providers/portfolio-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Sidebar } from "@/features/dashboard/sidebar";
import { Topbar } from "@/features/dashboard/topbar";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ensurePaperWallet } from "@/server/wallet";
import type {
  PaperOrderView,
  PaperPositionView,
  TradeHistoryView,
} from "@/types/portfolio";

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

  // JWT sessions are self-contained — they survive a database reset and would
  // point at a non-existent user, breaking every FK on PaperWallet/Position/
  // Order. Force the user back to /login (which re-issues the cookie via
  // authorize()) instead of crashing the layout.
  const userExists = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true },
  });
  
  if (!userExists) {
    // We must destroy the session cookies to prevent a redirect loop.
    // Cookies can only be modified in a Route Handler, so we redirect there.
    redirect("/api/auth/logout");
  }

  const [wallet, positions, orders, history] = await Promise.all([
    ensurePaperWallet(userId),
    prisma.paperPosition.findMany({
      where: { userId, status: { in: ["OPEN", "PARTIALLY_CLOSED"] } },
      orderBy: { createdAt: "desc" },
    }),
    prisma.paperOrder.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
    prisma.tradeHistory.findMany({
      where: { userId },
      orderBy: { closedAt: "desc" },
      take: 100,
    }),
  ]);

  const walletBalance = Number(wallet.balance);
  const usedMargin = Number(wallet.usedMargin);
  const currency = wallet.currency;

  const positionsView: PaperPositionView[] = positions.map((p) => ({
    id: p.id,
    symbol: p.symbol,
    side: p.side,
    quantity: Number(p.quantity),
    initialQuantity: Number(p.initialQuantity),
    entryPrice: Number(p.entryPrice),
    exitPrice: p.exitPrice ? Number(p.exitPrice) : null,
    takeProfit: p.takeProfit ? Number(p.takeProfit) : null,
    stopLoss: p.stopLoss ? Number(p.stopLoss) : null,
    leverage: p.leverage,
    marginUsed: Number(p.marginUsed),
    liquidationPrice: p.liquidationPrice ? Number(p.liquidationPrice) : null,
    walletBalanceSnapshot: p.walletBalanceSnapshot
      ? Number(p.walletBalanceSnapshot)
      : null,
    realizedPnl: Number(p.realizedPnl),
    unrealizedPnl: Number(p.unrealizedPnl),
    totalFees: Number(p.totalFees),
    status: p.status,
    closeReason: p.closeReason,
    decisionSource: p.decisionSource,
    decisionMeta: p.decisionMeta,
    createdAt: p.createdAt.toISOString(),
    closedAt: p.closedAt ? p.closedAt.toISOString() : null,
  }));

  const ordersView: PaperOrderView[] = orders.map((o) => ({
    id: o.id,
    symbol: o.symbol,
    side: o.side,
    orderType: o.orderType,
    quantity: Number(o.quantity),
    price: o.price ? Number(o.price) : null,
    filledPrice: o.filledPrice ? Number(o.filledPrice) : null,
    takeProfit: o.takeProfit ? Number(o.takeProfit) : null,
    stopLoss: o.stopLoss ? Number(o.stopLoss) : null,
    status: o.status,
    decisionSource: o.decisionSource,
    decisionMeta: o.decisionMeta,
    createdAt: o.createdAt.toISOString(),
    filledAt: o.filledAt ? o.filledAt.toISOString() : null,
    expiresAt: o.expiresAt ? o.expiresAt.toISOString() : null,
  }));

  const historyView: TradeHistoryView[] = history.map((h) => ({
    id: h.id,
    positionId: h.positionId,
    symbol: h.symbol,
    side: h.side,
    quantity: Number(h.quantity),
    entryPrice: Number(h.entryPrice),
    exitPrice: Number(h.exitPrice),
    pnl: Number(h.pnl),
    closeReason: h.closeReason,
    decisionSource: h.decisionSource,
    openedAt: h.openedAt.toISOString(),
    closedAt: h.closedAt.toISOString(),
    durationMs: h.durationMs,
    riskReward: h.riskReward,
  }));

  return (
    <TooltipProvider delayDuration={150} skipDelayDuration={250}>
    <div className="min-h-screen bg-[var(--color-bg)] text-[var(--fg)]">
      <div className="flex min-h-screen">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <MarketDataProvider>
            <PortfolioProvider
              walletBalance={walletBalance}
              usedMargin={usedMargin}
              currency={currency}
              positions={positionsView}
              orders={ordersView}
              tradeHistory={historyView}
            >
              <MatchingEngineSubscriber />
              <AiSignalEngine />
              <AiThesisSubscriber />
              <AiDecisionSubscriber />
              <AiExecutionEngine />
              <NewsSubscriber />
              <Topbar />
              <main className="flex-1 p-4 lg:p-5">{children}</main>
            </PortfolioProvider>
          </MarketDataProvider>
        </div>
      </div>
    </div>
    </TooltipProvider>
  );
}
