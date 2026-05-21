"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import {
  Activity,
  Brain,
  BrainCog,
  ChevronsLeft,
  CircuitBoard,
  Compass,
  GanttChartSquare,
  LayoutDashboard,
  LineChart,
  Newspaper,
  Settings,
  Wallet,
} from "lucide-react";

import { cn } from "@/lib/utils";

interface NavItem {
  href: string;
  label: string;
  icon: React.ElementType;
  badge?: string;
}

const NAV: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/groq", label: "Groq AI", icon: BrainCog, badge: "AI" },
  { href: "/markets", label: "Markets", icon: LineChart },
  { href: "/ai-signals", label: "AI Signals", icon: Brain, badge: "Live" },
  { href: "/paper-trading", label: "Paper Trading", icon: CircuitBoard },
  { href: "/news", label: "News", icon: Newspaper },
  { href: "/portfolio", label: "Portfolio", icon: GanttChartSquare },
  { href: "/ai-insights", label: "AI Insights", icon: Compass },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  return (
    <aside
      className={cn(
        "shrink-0 sticky top-0 h-screen flex flex-col border-r border-[var(--border)] bg-[var(--card)]/40 backdrop-blur transition-[width] duration-200",
        collapsed ? "w-[68px]" : "w-[232px]",
      )}
    >
      <div className="flex items-center justify-between px-3.5 h-14 border-b border-[var(--border)]">
        <Link href="/dashboard" className="flex items-center gap-2.5 min-w-0">
          <span
            aria-hidden
            className="inline-block h-6 w-6 rounded-md shrink-0"
            style={{
              background:
                "conic-gradient(from 220deg at 50% 50%, #00d4ff, #00e676, #00d4ff)",
              boxShadow: "0 0 16px -4px rgba(0,212,255,0.55)",
            }}
          />
          {!collapsed ? (
            <span className="text-[13px] font-semibold tracking-[0.18em] uppercase text-[var(--fg)] truncate">
              TradeFlow
            </span>
          ) : null}
        </Link>
        <button
          type="button"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={() => setCollapsed((v) => !v)}
          className="grid place-items-center size-7 rounded-md text-[var(--fg-muted)] hover:text-[var(--fg)] hover:bg-[var(--card-hover)] transition-colors"
        >
          <ChevronsLeft
            className={cn(
              "size-4 transition-transform",
              collapsed && "rotate-180",
            )}
          />
        </button>
      </div>

      <nav className="flex-1 px-2.5 py-3 space-y-0.5 overflow-y-auto">
        {NAV.map((item) => {
          const active =
            pathname === item.href || pathname.startsWith(`${item.href}/`);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "group relative flex items-center gap-3 rounded-md px-2.5 h-10 text-[13px] transition-all duration-200",
                active
                  ? "bg-[var(--accent-soft)] text-[var(--accent)] font-medium"
                  : "text-[var(--fg-muted)] hover:text-[var(--fg)] hover:bg-[var(--card-hover)]",
              )}
            >
              {active ? (
                <span
                  className="absolute left-0 top-1 bottom-1 w-[3px] rounded-r bg-[var(--accent)]"
                  style={{ boxShadow: "0 0 10px var(--accent)" }}
                />
              ) : null}
              <Icon
                className={cn(
                  "size-4 shrink-0 transition-transform group-hover:scale-110",
                  active && "text-[var(--accent)]",
                )}
              />
              {!collapsed ? (
                <>
                  <span className="flex-1 truncate">{item.label}</span>
                  {item.badge ? (
                    <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-[var(--bull-soft)] text-[var(--bull)] border border-[var(--bull)]/20">
                      {item.badge}
                    </span>
                  ) : null}
                </>
              ) : null}
            </Link>
          );
        })}
      </nav>

      <div
        className={cn(
          "m-2.5 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] p-3",
          collapsed && "hidden",
        )}
      >
        <div className="flex items-center gap-2 text-[var(--accent)]">
          <Activity className="size-3.5" />
          <span className="text-[10px] uppercase tracking-wider">
            Simulation Mode
          </span>
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--fg-muted)]">
          All orders execute against your paper portfolio. Live market data,
          virtual capital.
        </p>
      </div>

      {collapsed ? (
        <div className="m-2.5 grid place-items-center size-9 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] text-[var(--accent)]">
          <Wallet className="size-4" />
        </div>
      ) : null}
    </aside>
  );
}
