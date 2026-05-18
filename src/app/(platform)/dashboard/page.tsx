import { DashboardHeroMetrics } from "@/features/dashboard/dashboard-hero-metrics";
import { LiveDecisionPanel } from "@/features/ai-decision/live-decision-panel";
import { ChartPanel } from "@/features/chart/chart-panel";
import { LiveMarketMetrics } from "@/features/dashboard/live-market-metrics";
import { LiveWatchlist } from "@/features/markets/live-watchlist";
import { auth } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const session = await auth();

  if (!session?.user?.id) {
    return null;
  }

  return (
    <div className="grid min-h-[calc(100vh-5.5rem)] grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_390px]">
      <section className="flex min-w-0 flex-col gap-4">
        <DashboardHeroMetrics />

        <div className="min-h-[620px] flex-1">
          <ChartPanel />
        </div>
      </section>

      <aside className="flex min-w-0 flex-col gap-4">
        <LiveDecisionPanel />
        <LiveMarketMetrics />
        <LiveWatchlist compact />
      </aside>
    </div>
  );
}
