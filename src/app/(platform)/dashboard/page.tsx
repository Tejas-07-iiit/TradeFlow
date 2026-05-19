import { DashboardHeroMetrics } from "@/features/dashboard/dashboard-hero-metrics";
import { LiveDecisionPanel } from "@/features/ai-decision/live-decision-panel";
import { ChartPanel } from "@/features/chart/chart-panel";
import { LiveMarketMetrics } from "@/features/dashboard/live-market-metrics";
import { LiveWatchlist } from "@/features/markets/live-watchlist";
import { LiveAutoExecFeed } from "@/features/dashboard/live-auto-exec-feed";
import { NewsWidget } from "@/features/news/news-widget";
import { auth } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const session = await auth();

  if (!session?.user?.id) {
    return null;
  }

  return (
    <div className="flex flex-col gap-4 pb-8">
      <DashboardHeroMetrics />

      <div className="h-[650px] w-full">
        <ChartPanel />
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        <LiveDecisionPanel />
        <LiveAutoExecFeed />
        <NewsWidget />
        <LiveMarketMetrics />
        <LiveWatchlist compact />
      </div>
    </div>
  );
}
