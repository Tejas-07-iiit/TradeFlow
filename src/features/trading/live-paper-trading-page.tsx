"use client";

import { useState, useTransition } from "react";
import { BarChart3, CircleDollarSign, SlidersHorizontal, Wallet, X } from "lucide-react";
import { toast } from "sonner";

import { EmptyState, MetricCard, PageShell, StatusBadge } from "@/components/shared/page-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { cn, formatCurrency, formatPrice } from "@/lib/utils";
import { cancelPaperOrder, closePaperPosition, createPaperOrder } from "@/server/trading";
import { useMarketStore } from "@/store/market-store";
import { usePortfolioStore } from "@/store/portfolio-store";
import type { PaperOrderView, PaperPositionView } from "@/types/portfolio";

export function LivePaperTradingPage() {
  const tickers = useMarketStore((state) => state.tickers);
  const symbol = useMarketStore((state) => state.symbol);
  
  const balance = usePortfolioStore((s) => s.balance);
  const positions = usePortfolioStore((s) => s.positions);
  const orders = usePortfolioStore((s) => s.orders);

  const ticker = tickers[symbol];
  const lastPrice = ticker?.last ?? 0;

  const pendingOrders = orders.filter((o) => o.status === "PENDING");
  const orderHistory = orders.filter((o) => o.status !== "PENDING");

  const [side, setSide] = useState<"LONG" | "SHORT">("LONG");
  const [orderType, setOrderType] = useState<"MARKET" | "LIMIT">("MARKET");
  const [quantity, setQuantity] = useState("0.025");
  const [price, setPrice] = useState("");
  const [takeProfit, setTakeProfit] = useState("");
  const [stopLoss, setStopLoss] = useState("");
  const [isPending, startTransition] = useTransition();

  const livePnL = positions.reduce((sum, position) => {
    const mark = tickers[position.symbol]?.last ?? position.entryPrice;
    const direction = position.side === "LONG" ? 1 : -1;
    return sum + (mark - position.entryPrice) * position.quantity * direction;
  }, 0);

  const handleSubmit = () => {
    if (!lastPrice) return;
    const qty = parseFloat(quantity);
    if (isNaN(qty) || qty <= 0) {
      toast.error("Invalid quantity");
      return;
    }

    const limitPrice = orderType === "LIMIT" ? parseFloat(price) : undefined;
    if (orderType === "LIMIT" && (isNaN(limitPrice!) || limitPrice! <= 0)) {
      toast.error("Invalid limit price");
      return;
    }

    const tp = parseFloat(takeProfit);
    const sl = parseFloat(stopLoss);

    startTransition(async () => {
      try {
        await createPaperOrder({
          symbol,
          side,
          type: orderType,
          quantity: qty,
          price: limitPrice,
          takeProfit: isNaN(tp) ? undefined : tp,
          stopLoss: isNaN(sl) ? undefined : sl,
        });
        toast.success(`${side} order submitted`);
        if (orderType === "LIMIT") setPrice("");
        setTakeProfit("");
        setStopLoss("");
      } catch (error) {
        toast.error("Failed to submit order");
      }
    });
  };

  const handleCancel = (id: string) => {
    startTransition(async () => {
      try {
        await cancelPaperOrder(id);
        toast.success("Order cancelled");
      } catch (error) {
        toast.error("Failed to cancel order");
      }
    });
  };

  const handleClosePosition = (id: string, currentPrice: number) => {
    startTransition(async () => {
      try {
        await closePaperPosition(id, currentPrice);
        toast.success("Position closed");
      } catch (error) {
        toast.error("Failed to close position");
      }
    });
  };

  return (
    <PageShell
      eyebrow="Paper Trading"
      title="Simulated Execution Workspace"
      description="Virtual order entry, realtime mark prices, live unrealized PnL, and risk controls. No real exchange execution is enabled."
      action={<Badge variant="warn">Simulation mode only</Badge>}
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        <MetricCard label="Paper Balance" value={formatCurrency(balance)} detail="Virtual USDT" icon={Wallet} tone="accent" />
        <MetricCard label="Open PnL" value={formatCurrency(livePnL)} detail="Realtime mark-to-market" icon={BarChart3} tone={livePnL >= 0 ? "bull" : "bear"} />
        <MetricCard label="Mark Price" value={lastPrice ? formatPrice(lastPrice) : "Connecting"} detail={ticker ? `${ticker.changePct.toFixed(2)}% 24h` : "Binance stream"} icon={SlidersHorizontal} tone={ticker && ticker.changePct < 0 ? "bear" : "bull"} />
        <MetricCard label="Pending Orders" value={pendingOrders.length.toString()} detail="Database-backed" icon={CircleDollarSign} tone="muted" />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[390px_minmax(0,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Order Entry</CardTitle>
            <StatusBadge tone={side === "LONG" ? "bull" : "bear"}>{side}</StatusBadge>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant={side === "LONG" ? "bull" : "outline"}
                onClick={() => setSide("LONG")}
                className="h-11"
              >
                Buy / Long
              </Button>
              <Button
                variant={side === "SHORT" ? "bear" : "outline"}
                onClick={() => setSide("SHORT")}
                className="h-11"
              >
                Sell / Short
              </Button>
            </div>

            <div className="grid grid-cols-2 gap-2 p-1 rounded-md bg-white/[0.02] border border-[var(--color-border)]">
              <button
                onClick={() => setOrderType("MARKET")}
                className={cn(
                  "py-1.5 text-xs font-medium rounded transition-colors",
                  orderType === "MARKET" ? "bg-[var(--color-accent)] text-white" : "text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)]"
                )}
              >
                Market
              </button>
              <button
                onClick={() => setOrderType("LIMIT")}
                className={cn(
                  "py-1.5 text-xs font-medium rounded transition-colors",
                  orderType === "LIMIT" ? "bg-[var(--color-accent)] text-white" : "text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)]"
                )}
              >
                Limit
              </button>
            </div>

            <div className="space-y-1.5">
              <Label>Symbol</Label>
              <Input value={symbol} readOnly className="bg-white/[0.01]" />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>Quantity</Label>
                <Input
                  type="number"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  placeholder="0.00"
                />
              </div>
              <div className="space-y-1.5">
                <Label>{orderType === "LIMIT" ? "Limit Price" : "Market Price"}</Label>
                <Input
                  type="number"
                  value={orderType === "LIMIT" ? price : lastPrice.toString()}
                  onChange={(e) => setPrice(e.target.value)}
                  readOnly={orderType === "MARKET"}
                  className={orderType === "MARKET" ? "bg-white/[0.01] opacity-60" : ""}
                  placeholder={lastPrice.toString()}
                />
              </div>
            </div>

            <Separator className="bg-white/[0.05]" />

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label className="text-[var(--color-bull)]">Take Profit</Label>
                <Input
                  type="number"
                  value={takeProfit}
                  onChange={(e) => setTakeProfit(e.target.value)}
                  placeholder="Exit target"
                  className="border-[var(--color-bull-soft)] focus-visible:ring-[var(--color-bull)]"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-[var(--color-bear)]">Stop Loss</Label>
                <Input
                  type="number"
                  value={stopLoss}
                  onChange={(e) => setStopLoss(e.target.value)}
                  placeholder="Risk limit"
                  className="border-[var(--color-bear-soft)] focus-visible:ring-[var(--color-bear)]"
                />
              </div>
            </div>

            <div className="pt-2">
              <Button
                className="w-full h-11"
                variant={side === "LONG" ? "bull" : "bear"}
                disabled={isPending || !lastPrice}
                onClick={handleSubmit}
              >
                {isPending ? "Submitting..." : `Submit ${side} Order`}
              </Button>
            </div>

            <p className="text-[10px] text-center text-[var(--color-fg-subtle)] leading-relaxed">
              Execution is simulated. Market orders fill at current mark price.
              Position risk controls (TP/SL) will auto-close the trade.
            </p>
          </CardContent>
        </Card>

        <section className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Open Positions</CardTitle>
              <Badge variant="muted">{positions.length} positions</Badge>
            </CardHeader>
            <CardContent className="space-y-2">
              {positions.length === 0 ? (
                <EmptyState title="No open positions" description="Open positions will mark to live Binance prices once the paper execution engine creates them." />
              ) : positions.map((position) => {
                const ticker = tickers[position.symbol];
                const mark = ticker?.last ?? position.entryPrice;
                const direction = position.side === "LONG" ? 1 : -1;
                const pnl = (mark - position.entryPrice) * position.quantity * direction;
                return (
                  <div key={position.id} className="grid grid-cols-2 gap-3 rounded-md border border-[var(--color-border)] bg-white/[0.02] p-3 md:grid-cols-7">
                    <Cell label="Symbol" value={position.symbol} />
                    <Cell label="Side" value={position.side} tone={position.side === "LONG" ? "bull" : "bear"} />
                    <Cell label="Qty" value={position.quantity.toString()} />
                    <Cell label="Entry" value={formatPrice(position.entryPrice)} />
                    <Cell label="TP / SL" value={`${position.takeProfit ? formatPrice(position.takeProfit) : "—"} / ${position.stopLoss ? formatPrice(position.stopLoss) : "—"}`} />
                    <Cell label="Mark" value={formatPrice(mark)} />
                    <div className="flex items-center justify-between col-span-2 md:col-span-1">
                      <Cell label="PnL" value={formatCurrency(pnl)} tone={pnl >= 0 ? "bull" : "bear"} />
                      <button
                        onClick={() => handleClosePosition(position.id, mark)}
                        className="p-1 hover:bg-white/10 rounded-md transition-colors text-[var(--color-bear)] hover:bg-[var(--color-bear-soft)]"
                        title="Close Position"
                      >
                        <X className="size-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Pending Orders</CardTitle>
              <Badge variant="muted">{pendingOrders.length} active</Badge>
            </CardHeader>
            <CardContent className="space-y-2">
              {pendingOrders.length === 0 ? (
                <EmptyState title="No pending orders" description="Orders waiting for execution will appear here. Market orders fill nearly instantly." />
              ) : pendingOrders.map((order) => (
                <div key={order.id} className="flex items-center justify-between rounded-md bg-white/[0.025] px-3 py-2.5">
                  <div className="flex gap-4 items-center">
                    <div className={cn("text-xs font-bold px-1.5 py-0.5 rounded", order.side === "LONG" ? "bg-[var(--color-bull-soft)] text-[var(--color-bull)]" : "bg-[var(--color-bear-soft)] text-[var(--color-bear)]")}>
                      {order.side}
                    </div>
                    <div>
                      <div className="text-sm font-medium text-[var(--color-fg)]">{order.symbol}</div>
                      <div className="text-xs text-[var(--color-fg-subtle)]">{order.orderType} · {order.quantity} @ {order.price ? formatPrice(order.price) : "MARKET"}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge variant="muted">{order.status}</Badge>
                    <button
                      onClick={() => handleCancel(order.id)}
                      className="p-1 hover:bg-white/10 rounded-md transition-colors text-[var(--color-bear)]"
                      title="Cancel Order"
                    >
                      <X className="size-4" />
                    </button>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Trade History</CardTitle>
              <Badge variant="muted">Last 10</Badge>
            </CardHeader>
            <CardContent className="space-y-2">
              {orderHistory.length === 0 ? (
                <div className="py-4 text-center text-xs text-[var(--color-fg-subtle)]">No recent trade history</div>
              ) : orderHistory.slice(0, 10).map((order) => (
                <div key={order.id} className="flex items-center justify-between rounded-md bg-white/[0.01] px-3 py-2 border border-[var(--color-border)] opacity-70">
                  <div className="flex gap-4 items-center">
                    <div className={cn("text-[10px] font-bold px-1 py-0.5 rounded", order.side === "LONG" ? "text-[var(--color-bull)]" : "text-[var(--color-bear)]")}>
                      {order.side}
                    </div>
                    <div>
                      <div className="text-xs font-medium text-[var(--color-fg)]">{order.symbol}</div>
                      <div className="text-[10px] text-[var(--color-fg-subtle)]">{order.orderType} · {order.quantity}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="text-[10px] font-mono text-[var(--color-fg-subtle)]">{order.price ? formatPrice(order.price) : "MARKET"}</div>
                    <Badge variant="muted" className="text-[9px] h-4 px-1">{order.status}</Badge>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </section>
      </div>
    </PageShell>
  );
}

function Cell({ label, value, tone }: { label: string; value: string; tone?: "bull" | "bear" }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-[var(--color-fg-subtle)]">{label}</div>
      <div className={cn("mt-1 text-mono-tabular text-sm", tone === "bull" ? "text-[var(--color-bull)]" : tone === "bear" ? "text-[var(--color-bear)]" : "text-[var(--color-fg)]")}>{value}</div>
    </div>
  );
}
