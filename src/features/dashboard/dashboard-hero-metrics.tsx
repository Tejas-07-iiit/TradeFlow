"use client";

import {
  CircleDollarSign,
  Gauge,
  ShieldCheck,
  Wallet,
} from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";
import { usePortfolioStore } from "@/store/portfolio-store";

export function DashboardHeroMetrics() {
  const balance = usePortfolioStore((s) => s.balance);
  const currency = usePortfolioStore((s) => s.currency);
  const positions = usePortfolioStore((s) => s.positions);
  const orders = usePortfolioStore((s) => s.orders);

  const openPositions = positions.filter((p) => p.status === "OPEN").length;
  const pendingOrders = orders.filter((o) => o.status === "PENDING").length;

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
      <HeroMetric
        label="Paper Equity"
        value={formatCurrency(balance, currency)}
        icon={Wallet}
        tone="accent"
      />
      <HeroMetric
        label="Open Positions"
        value={openPositions.toString()}
        icon={Gauge}
        tone="muted"
      />
      <HeroMetric
        label="Pending Orders"
        value={pendingOrders.toString()}
        icon={CircleDollarSign}
        tone="muted"
      />
      <HeroMetric
        label="Risk Engine"
        value="Simulation"
        icon={ShieldCheck}
        tone="bull"
      />
    </div>
  );
}

function HeroMetric({
  label,
  value,
  icon: Icon,
  tone,
}: {
  label: string;
  value: string;
  icon: React.ElementType;
  tone: "accent" | "bull" | "muted";
}) {
  return (
    <Card className="overflow-hidden">
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <div className="text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">
            {label}
          </div>
          <Icon
            className={
              tone === "accent"
                ? "size-4 text-[var(--color-accent)]"
                : tone === "bull"
                  ? "size-4 text-[var(--color-bull)]"
                  : "size-4 text-[var(--color-fg-muted)]"
            }
          />
        </div>
        <div className="mt-3 text-mono-tabular text-lg font-semibold tracking-tight text-[var(--color-fg)]">
          {value}
        </div>
      </CardContent>
    </Card>
  );
}
