"use client";

import { signOut } from "next-auth/react";
import { useSession } from "next-auth/react";
import { Bell, ChevronDown, LogOut, Search, Settings, User2 } from "lucide-react";

import {
  Avatar,
  AvatarFallback,
} from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAccountMetrics } from "@/hooks/use-position-metrics";
import { WATCHLIST_SYMBOLS } from "@/lib/market/symbols";
import { cn, formatCurrency, formatPct, formatPrice } from "@/lib/utils";
import { useMarketStore } from "@/store/market-store";

import { ConnectionStatus } from "./connection-status";

// Use the canonical watchlist so this dropdown can't drift from the rest
// of the system (signal engine, news subscriber, AI decision watcher).
const SUPPORTED_SYMBOLS = WATCHLIST_SYMBOLS;

export function Topbar() {
  const { data: session } = useSession();
  const symbol = useMarketStore((s) => s.symbol);
  const setSymbol = useMarketStore((s) => s.setSymbol);
  const ticker = useMarketStore((s) => s.ticker);
  const lastPrice = useMarketStore((s) => s.lastPrice);
  
  const account = useAccountMetrics();

  const change = ticker?.changePct ?? 0;
  const up = change >= 0;

  const initials = (session?.user?.name || session?.user?.email || "T")
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <header className="sticky top-0 z-30 h-14 border-b border-[var(--color-border)] bg-[var(--color-bg)]/85 backdrop-blur-xl">
      <div className="h-full flex items-center justify-between gap-4 px-5">
        {/* Left: ticker tape + Symbol Selector */}
        <div className="flex items-center gap-4 min-w-0">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="flex items-center gap-2 hover:bg-white/5 px-2 py-1 rounded-md transition-colors">
                <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-fg)]">
                  {symbol.replace("USDT", " / USDT")}
                </span>
                <ChevronDown className="size-3 text-[var(--color-fg-subtle)]" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuLabel>Select Symbol</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {SUPPORTED_SYMBOLS.map((s) => (
                <DropdownMenuItem key={s} onSelect={() => setSymbol(s)}>
                  {s.replace("USDT", " / USDT")}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <div className="flex items-baseline gap-2">
            <span
              className={cn(
                "text-mono-tabular text-[15px] font-semibold tabular-nums",
                up ? "text-[var(--color-bull)]" : "text-[var(--color-bear)]",
              )}
            >
              {lastPrice != null ? formatPrice(lastPrice) : "—"}
            </span>
            <span
              className={cn(
                "text-mono-tabular text-[11px]",
                up ? "text-[var(--color-bull)]" : "text-[var(--color-bear)]",
              )}
            >
              {ticker ? formatPct(ticker.changePct) : "—"}
            </span>
          </div>

          <Separator orientation="vertical" className="h-5 hidden md:block" />

          <div className="hidden md:flex items-center gap-2">
            <ConnectionStatus />
            <Badge variant="muted">Markets · Open 24/7</Badge>
          </div>
        </div>

        {/* Center: search */}
        <div className="hidden lg:flex flex-1 max-w-md items-center gap-2 h-9 px-3 rounded-md border border-[var(--color-border)] bg-white/[0.02] text-[var(--color-fg-subtle)]">
          <Search className="size-3.5" />
          <input
            placeholder="Search symbols, strategies, signals…"
            className="bg-transparent flex-1 text-[13px] placeholder:text-[var(--color-fg-subtle)] focus:outline-none text-[var(--color-fg)]"
          />
          <kbd className="text-[10px] text-[var(--color-fg-subtle)] border border-[var(--color-border)] rounded px-1 py-0.5">
            ⌘ K
          </kbd>
        </div>

        {/* Right: wallet + profile */}
        <div className="flex items-center gap-3">
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="hidden sm:flex flex-col items-end leading-tight cursor-help">
                <span className="text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">
                  Equity
                </span>
                <span className="text-mono-tabular text-[13px] text-[var(--color-fg)]">
                  {formatCurrency(account.totalEquity, account.currency)}
                </span>
                <span className="text-mono-tabular text-[10px] text-[var(--color-fg-subtle)]">
                  Avail {formatCurrency(account.availableBalance, account.currency)}
                </span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-[11px] leading-relaxed">
              <div className="space-y-1">
                <Row label="Wallet" value={formatCurrency(account.walletBalance, account.currency)} />
                <Row label="Used margin" value={formatCurrency(account.usedMargin, account.currency)} />
                <Row label="Available" value={formatCurrency(account.availableBalance, account.currency)} />
                <Row
                  label="Unrealized PnL"
                  value={formatCurrency(account.unrealizedPnl, account.currency)}
                  tone={account.unrealizedPnl >= 0 ? "bull" : "bear"}
                />
                <div className="pt-1 mt-1 border-t border-[var(--color-border)]">
                  <Row label="Total equity" value={formatCurrency(account.totalEquity, account.currency)} strong />
                </div>
              </div>
            </TooltipContent>
          </Tooltip>

          <button
            type="button"
            aria-label="Notifications"
            className="relative grid place-items-center size-9 rounded-md border border-[var(--color-border)] bg-white/[0.02] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] hover:bg-white/[0.05]"
          >
            <Bell className="size-4" />
            <span className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-[var(--color-accent)]" />
          </button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-white/[0.02] pl-1 pr-2 h-9 hover:bg-white/[0.05]"
              >
                <Avatar className="size-7">
                  <AvatarFallback>{initials}</AvatarFallback>
                </Avatar>
                <span className="hidden md:block text-[12px] text-[var(--color-fg)] max-w-[120px] truncate">
                  {session?.user?.name || session?.user?.email || "Account"}
                </span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>
                {session?.user?.email ?? "Trader"}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem>
                <User2 className="size-3.5 mr-2" /> Profile
              </DropdownMenuItem>
              <DropdownMenuItem>
                <Settings className="size-3.5 mr-2" /> Settings
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={(e) => {
                  e.preventDefault();
                  void signOut({ callbackUrl: "/login" });
                }}
                className="text-[var(--color-bear)]"
              >
                <LogOut className="size-3.5 mr-2" /> Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  );
}

function Row({
  label,
  value,
  tone,
  strong,
}: {
  label: string;
  value: string;
  tone?: "bull" | "bear";
  strong?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-6">
      <span className="text-[var(--color-fg-muted)]">{label}</span>
      <span
        className={cn(
          "text-mono-tabular tabular-nums",
          strong && "font-semibold",
          tone === "bull"
            ? "text-[var(--color-bull)]"
            : tone === "bear"
              ? "text-[var(--color-bear)]"
              : "text-[var(--color-fg)]",
        )}
      >
        {value}
      </span>
    </div>
  );
}
