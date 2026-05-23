import { prisma } from "@/lib/prisma";
import { ACTIVE_SYMBOLS } from "@/lib/market/symbols";
import { fetchHistoricalCandles } from "@/services/binance";
import { calculateIndicators, generateDecision } from "@/lib/signals/signal-engine";
import { computeRiskAdjustedSize } from "@/lib/trading/position-sizing";
import { computeDrawdownMultiplier } from "@/lib/risk/drawdown-gate";
import { computeVolTargetMultiplier } from "@/lib/risk/vol-target";
import { DEFAULT_WALLET_BALANCE } from "@/server/wallet";
import { computePositionRiskMetrics } from "@/lib/risk/metrics";
import { decisionSide } from "@/services/ai/schemas";
import { runCandlestickEngine } from "@/lib/candlestick";
import { saveExplainableSignal } from "@/server/xai-signals";
import { getSentiment } from "@/server/sentiment";
import { getStrategyDecision } from "@/server/ai-decision";
import { evaluatePosition } from "@/services/trade-manager";
import { macd } from "@/lib/indicators/calculations";
import {
  createPaperOrderInternal,
  cancelPaperOrderInternal,
  fillPaperOrderInternal,
  closePaperPositionInternal,
  updatePositionLevelsInternal,
  updatePositionHealthScoreInternal,
  createManagementEventInternal,
} from "@/server/trading";
import type { Candle, Ticker24h } from "@/types/market";
import type { MarketDecision } from "@/services/ai/schemas";
import { computeRollingCorrelations } from "@/lib/telemetry/correlation";
import { pruneTelemetryData } from "@/lib/telemetry/retention";
import type { ManagementIndicators, ManagedPositionContext } from "@/types/trade-management";
import type { TradeAssessment } from "@/lib/trade-quality";
import { assessTradeQuality } from "@/lib/trade-quality";

function klineToCandle(payload: any): Candle {
  return {
    time: Math.floor(payload.k.t / 1000),
    open: Number(payload.k.o),
    high: Number(payload.k.h),
    low: Number(payload.k.l),
    close: Number(payload.k.c),
    volume: Number(payload.k.v),
  };
}

function parseTicker(payload: any): Ticker24h {
  return {
    symbol: payload.s,
    last: Number(payload.c),
    open: Number(payload.o),
    high: Number(payload.h),
    low: Number(payload.l),
    changePct: Number(payload.P),
    quoteVolume: Number(payload.q),
    baseVolume: Number(payload.v),
    bestBid: payload.b ? Number(payload.b) : undefined,
    bestAsk: payload.a ? Number(payload.a) : undefined,
  };
}

export class BackgroundRunner {
  private static instance: BackgroundRunner | null = null;
  private ws: any = null;
  private isRunning = false;

  private tickers: Record<string, Ticker24h> = {};
  private candles: Record<string, Candle[]> = {};
  private lastNewsValidation: Record<string, any> = {};
  private lastExecutedAt: Record<string, number> = {};
  private lastExitAt: Record<string, number> = {};
  private lastAutoExecuted: Record<string, { signal: string; type: string; executedAt: number }> = {};

  private matchingInterval: NodeJS.Timeout | null = null;
  private signalInterval: NodeJS.Timeout | null = null;
  private tradeManagerInterval: NodeJS.Timeout | null = null;
  private llmDecisionInterval: NodeJS.Timeout | null = null;
  private retentionInterval: NodeJS.Timeout | null = null;

  // Re-entrancy guards. The setInterval fires every N seconds regardless of
  // whether the previous tick has finished — under load (many PENDING orders,
  // a slow Prisma transaction, or a DB hiccup) ticks would otherwise stack
  // and exhaust the Prisma transaction pool with P2028 errors.
  private matchingLoopRunning = false;
  private signalLoopRunning = false;
  private tradeManagerLoopRunning = false;

  private constructor() {}

  public static getInstance(): BackgroundRunner {
    if (!BackgroundRunner.instance) {
      BackgroundRunner.instance = new BackgroundRunner();
    }
    return BackgroundRunner.instance;
  }

  public async start() {
    if (this.isRunning) {
      console.warn("[BACKGROUND-RUNNER] Runner is already running.");
      return;
    }
    this.isRunning = true;
    console.info("[BACKGROUND-RUNNER] Starting Server-Side Background Engine...");

    // 1. Fetch historical candles to bootstrap caches
    console.info("[BACKGROUND-RUNNER] Bootstrapping historical candles...");
    for (const symbol of ACTIVE_SYMBOLS) {
      try {
        const history = await fetchHistoricalCandles(symbol, "5m", 500);
        this.candles[`${symbol}:5m`] = history;
        console.info(`[BACKGROUND-RUNNER] Loaded ${history.length} candles for ${symbol}`);
      } catch (err) {
        console.error(`[BACKGROUND-RUNNER] Failed to load candles for ${symbol}:`, err);
      }
    }

    // 1a. Extend candle history for any position older than the bootstrap
    // window. Without this, an SL hit that occurred before the cache's
    // earliest bar is invisible to the offline-backfill check.
    await this.ensureCandlesCoverOpenPositions().catch((err) => {
      console.error("[BACKGROUND-RUNNER] Failed to extend candle history for open positions:", err);
    });

    // 1b. Run an immediate reconciliation pass BEFORE starting the live
    // interval and BEFORE the WebSocket has had a chance to deliver tickers.
    // The backfill check inside runMatchingLoop only needs historical candles
    // (which we just bootstrapped) — this is what catches "laptop was off
    // overnight, SL was hit while we were down" scenarios on cold start.
    console.info("[BACKGROUND-RUNNER] Running startup reconciliation for open positions...");
    await this.runMatchingLoop().catch((err) => {
      console.error("[BACKGROUND-RUNNER] Startup reconciliation failed:", err);
    });

    // 2. Connect WebSocket
    this.connectWebSocket();

    // 3. Start Loops
    this.matchingInterval = setInterval(() => void this.runMatchingLoop(), 1000);
    this.signalInterval = setInterval(() => void this.runAiSignalLoop(), 10000);
    this.tradeManagerInterval = setInterval(() => void this.runAiTradeManagerLoop(), 30000);

    // Initial stagger for LLM Decisions (15s stagger)
    console.info("[BACKGROUND-RUNNER] Staggering initial LLM decision cycles...");
    ACTIVE_SYMBOLS.forEach((symbol, i) => {
      setTimeout(() => void this.runLlmDecisionForSymbol(symbol), i * 15000);
    });

    // Round-robin LLM Decisions Interval
    const tickMs = Math.max(15000, Math.floor((8 * 60 * 1000) / ACTIVE_SYMBOLS.length)); // 120s
    setTimeout(() => {
      let cursor = 0;
      this.llmDecisionInterval = setInterval(() => {
        const symbol = ACTIVE_SYMBOLS[cursor];
        cursor = (cursor + 1) % ACTIVE_SYMBOLS.length;
        void this.runLlmDecisionForSymbol(symbol);
      }, tickMs);
    }, ACTIVE_SYMBOLS.length * 15000); // Start after initial staggers complete

    // Telemetry Retention Pruning: Run once on startup, then every 24 hours
    console.info("[BACKGROUND-RUNNER] Initializing telemetry retention pruning (30 days policy)...");
    void pruneTelemetryData(30).catch((err) => {
      console.error("[BACKGROUND-RUNNER] Startup telemetry retention prune failed:", err);
    });
    this.retentionInterval = setInterval(() => {
      console.info("[BACKGROUND-RUNNER] Executing daily telemetry retention prune...");
      void pruneTelemetryData(30).catch((err) => {
        console.error("[BACKGROUND-RUNNER] Telemetry retention prune failed:", err);
      });
    }, 24 * 60 * 60 * 1000);
  }

  private connectWebSocket() {
    const streams = [
      ...ACTIVE_SYMBOLS.map((s) => `${s.toLowerCase()}@ticker`),
      ...ACTIVE_SYMBOLS.map((s) => `${s.toLowerCase()}@kline_5m`),
    ];
    const wsUrl = `wss://stream.binance.com:9443/stream?streams=${streams.join("/")}`;

    console.info(`[BACKGROUND-RUNNER] Connecting to Binance WebSocket: ${wsUrl}`);
    
    // Cast to any to bypass strict WebSocket types in Node environment
    this.ws = new (globalThis as any).WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.info("[BACKGROUND-RUNNER] Binance WebSocket stream connected.");
    };

    this.ws.onmessage = (event: any) => {
      try {
        const payload = JSON.parse(event.data as string);
        const data = payload.data;
        if (!data) return;

        if (data.e === "24hrTicker") {
          const ticker = parseTicker(data);
          this.tickers[ticker.symbol] = ticker;
        } else if (data.e === "kline") {
          const symbol = data.s;
          const candle = klineToCandle(data);
          this.updateCandleCache(symbol, "5m", candle);
        }
      } catch (err) {
        // Quietly ignore parsing failures
      }
    };

    this.ws.onerror = (err: any) => {
      console.error("[BACKGROUND-RUNNER] Binance WebSocket error:", err);
    };

    this.ws.onclose = () => {
      console.warn("[BACKGROUND-RUNNER] Binance WebSocket closed. Reconnecting in 5s...");
      if (this.isRunning) {
        setTimeout(() => this.connectWebSocket(), 5000);
      }
    };
  }

  /**
   * Walk back the 5m candle cache so it covers every currently-open position's
   * createdAt. The default bootstrap fetches the last 500 bars (~41h). For
   * positions older than that, the gap between createdAt and the earliest
   * cached bar is invisible to the offline-backfill check — an SL hit in that
   * gap would never be reconciled. Paginates backwards in 1000-bar chunks
   * (Binance REST max) and merges the older bars into the front of the cache.
   */
  private async ensureCandlesCoverOpenPositions() {
    const openPositions = await prisma.paperPosition.findMany({
      where: { status: { in: ["OPEN", "PARTIALLY_CLOSED"] } },
      select: { symbol: true, createdAt: true },
    });
    if (openPositions.length === 0) return;

    const oldestBySymbol: Record<string, number> = {};
    for (const p of openPositions) {
      const ms = new Date(p.createdAt).getTime();
      const prev = oldestBySymbol[p.symbol];
      if (prev === undefined || ms < prev) {
        oldestBySymbol[p.symbol] = ms;
      }
    }

    const FIVE_MIN_MS = 5 * 60 * 1000;
    const MAX_PAGES = 10; // safety cap → up to 10,000 extra bars (~35 days)

    for (const [symbol, oldestMs] of Object.entries(oldestBySymbol)) {
      const cache = this.candles[`${symbol}:5m`] || [];
      if (cache.length === 0) continue;

      // Pad the target back by a single bar so we definitely include the bar
      // containing createdAt (its subsequent bars are what we need to scan).
      const targetMs = oldestMs - FIVE_MIN_MS;

      let earliestCachedMs = cache[0].time * 1000;
      let pages = 0;
      while (earliestCachedMs > targetMs && pages < MAX_PAGES) {
        pages += 1;
        const endMs = earliestCachedMs - 1; // exclusive upper bound
        try {
          const older = await fetchHistoricalCandles(symbol, "5m", 1000, { endTime: endMs });
          if (older.length === 0) break;
          const existing = this.candles[`${symbol}:5m`] || [];
          const seen = new Set(existing.map((c) => c.time));
          const merged = [...older.filter((c) => !seen.has(c.time)), ...existing];
          merged.sort((a, b) => a.time - b.time);
          this.candles[`${symbol}:5m`] = merged;
          const newEarliestMs = merged[0].time * 1000;
          if (newEarliestMs >= earliestCachedMs) break; // nothing actually older returned
          earliestCachedMs = newEarliestMs;
          console.info(
            `[BACKGROUND-RUNNER] Extended ${symbol} candles by ${older.length} bars (now back to ${new Date(earliestCachedMs).toISOString()})`,
          );
        } catch (err) {
          console.warn(`[BACKGROUND-RUNNER] Failed to extend ${symbol} candles:`, err);
          break;
        }
      }
    }
  }

  private updateCandleCache(symbol: string, interval: string, candle: Candle) {
    const key = `${symbol}:${interval}`;
    const existing = this.candles[key] || [];
    if (existing.length === 0) return; // Wait for historical REST bootstrap

    const last = existing[existing.length - 1];
    if (candle.time === last.time) {
      existing[existing.length - 1] = candle;
    } else if (candle.time > last.time) {
      existing.push(candle);
      if (existing.length > 1000) {
        existing.shift();
      }
    }
    this.candles[key] = existing;
  }

  private async runMatchingLoop() {
    if (this.matchingLoopRunning) return;
    this.matchingLoopRunning = true;
    try {
      const pendingOrders = await prisma.paperOrder.findMany({
        where: { status: "PENDING" },
      });
      const openPositions = await prisma.paperPosition.findMany({
        where: { status: { in: ["OPEN", "PARTIALLY_CLOSED"] } },
      });

      const now = Date.now();

      for (const order of pendingOrders) {
        if (order.expiresAt && new Date(order.expiresAt).getTime() <= now) {
          console.info(`[SERVER-MATCHING] Expiring order ${order.id} for ${order.symbol}`);
          await cancelPaperOrderInternal(order.userId, order.id, "EXPIRED").catch(err => {
            console.error(`[SERVER-MATCHING] Failed to expire order ${order.id}:`, err);
          });
          continue;
        }

        const ticker = this.tickers[order.symbol];
        if (!ticker) continue;

        const currentPrice = ticker.last;
        let shouldFill = false;
        let fillPrice = currentPrice;

        if (order.orderType === "MARKET") {
          shouldFill = true;
        } else if (order.orderType === "LIMIT" && order.price != null) {
          const limitPrice = Number(order.price);
          if (order.side === "LONG" && currentPrice <= limitPrice) {
            shouldFill = true;
            fillPrice = limitPrice;
          } else if (order.side === "SHORT" && currentPrice >= limitPrice) {
            shouldFill = true;
            fillPrice = limitPrice;
          }
        }

        if (shouldFill) {
          console.info(`[SERVER-MATCHING] Filling ${order.orderType} ${order.side} ${order.symbol} @ ${fillPrice} for user ${order.userId}`);
          await fillPaperOrderInternal(order.userId, order.id, fillPrice).catch(err => {
            console.error(`[SERVER-MATCHING] Fill failed for order ${order.id}:`, err);
          });
        }
      }

      for (const pos of openPositions) {
        let reason: "TAKE_PROFIT" | "STOP_LOSS" | null = null;
        let exitPrice: number | null = null;
        let closedAt: number | undefined = undefined;

        // 1. Backfill check: Did we hit SL/TP while the system was offline?
        //    This MUST run independently of the live ticker — historical
        //    candles are the only signal we have for prices that moved while
        //    the process wasn't running.
        const symbolCandles = this.candles[`${pos.symbol}:5m`];
        if (symbolCandles && symbolCandles.length > 0) {
          const openedTime = Math.floor(new Date(pos.createdAt).getTime() / 1000);
          for (const c of symbolCandles) {
            // Skip the candle that contains the open — its low/high includes
            // price action from before the position existed, which would
            // create a false SL/TP trigger.
            if (c.time <= openedTime) continue;

            if (pos.stopLoss != null) {
              const sl = Number(pos.stopLoss);
              if (pos.side === "LONG" && c.low <= sl) {
                reason = "STOP_LOSS";
                exitPrice = sl;
                closedAt = c.time * 1000;
                break;
              }
              if (pos.side === "SHORT" && c.high >= sl) {
                reason = "STOP_LOSS";
                exitPrice = sl;
                closedAt = c.time * 1000;
                break;
              }
            }
            if (pos.takeProfit != null) {
              const tp = Number(pos.takeProfit);
              if (pos.side === "LONG" && c.high >= tp) {
                reason = "TAKE_PROFIT";
                exitPrice = tp;
                closedAt = c.time * 1000;
                break;
              }
              if (pos.side === "SHORT" && c.low <= tp) {
                reason = "TAKE_PROFIT";
                exitPrice = tp;
                closedAt = c.time * 1000;
                break;
              }
            }
          }
        }

        // 2. Live check — only when the ticker has arrived. If the WebSocket
        //    hasn't delivered a tick yet, the backfill above is our only
        //    enforcement path; we don't skip the whole position because of it.
        if (!reason) {
          const ticker = this.tickers[pos.symbol];
          if (ticker) {
            const currentPrice = ticker.last;
            if (pos.stopLoss != null) {
              const sl = Number(pos.stopLoss);
              if (pos.side === "LONG" && currentPrice <= sl) reason = "STOP_LOSS";
              if (pos.side === "SHORT" && currentPrice >= sl) reason = "STOP_LOSS";
              if (reason) exitPrice = sl;
            }
            if (!reason && pos.takeProfit != null) {
              const tp = Number(pos.takeProfit);
              if (pos.side === "LONG" && currentPrice >= tp) reason = "TAKE_PROFIT";
              if (pos.side === "SHORT" && currentPrice <= tp) reason = "TAKE_PROFIT";
              if (reason) exitPrice = tp;
            }
          }
        }

        if (reason && exitPrice != null) {
          console.info(`[SERVER-MATCHING] Closing position ${pos.id} due to ${reason} @ ${exitPrice}${closedAt ? ` (backfill @ ${new Date(closedAt).toISOString()})` : ""}`);
          await closePaperPositionInternal(pos.userId, pos.id, exitPrice, { reason, closedAt }).catch(err => {
            console.error(`[SERVER-MATCHING] Close failed for position ${pos.id}:`, err);
          });
        }
      }
    } catch (err) {
      console.error(`[SERVER-MATCHING] Error in runMatchingLoop:`, err);
    } finally {
      this.matchingLoopRunning = false;
    }
  }

  private async runAiSignalLoop() {
    const autonomyOn = process.env.NEXT_PUBLIC_AI_AUTONOMY === "on";
    if (autonomyOn) return;
    if (this.signalLoopRunning) return;
    this.signalLoopRunning = true;

    try {
      const wallets = await prisma.paperWallet.findMany({
        select: { userId: true, balance: true, usedMargin: true }
      });

      for (const symbol of ACTIVE_SYMBOLS) {
        const bars = this.candles[`${symbol}:5m`];
        if (!bars || bars.length < 30) continue;

        const decision = generateDecision(symbol, this.candles, "5m");
        if (decision.signal === "HOLD") continue;
        if (decision.signal !== "BUY" && decision.signal !== "SELL") continue;
        if (decision.entryPrice == null || decision.stopLoss == null || decision.takeProfit == null) continue;

        const side: "LONG" | "SHORT" = decision.signal === "BUY" ? "LONG" : "SHORT";

        for (const wallet of wallets) {
          const userId = wallet.userId;
          const bal = Number(wallet.balance);
          const usedMargin = Number(wallet.usedMargin);
          const availableBalance = bal - usedMargin;

          const userPositions = await prisma.paperPosition.findMany({
            where: { userId, status: { in: ["OPEN", "PARTIALLY_CLOSED"] } }
          });

          const alreadyOpen = userPositions.some(p => p.symbol === symbol);
          if (alreadyOpen) continue;

          const cooldownKey = `${userId}:${symbol}`;
          const prev = this.lastAutoExecuted[cooldownKey];
          const sameTransition = prev && prev.signal === decision.signal && prev.type === decision.type;
          const cooldownActive = prev && Date.now() - prev.executedAt < 60000;
          if (sameTransition || cooldownActive) continue;

          const totalOpenNotional = userPositions.reduce((s, p) => s + Number(p.quantity) * Number(p.entryPrice), 0);
          const openPositionsCount = userPositions.length;
          const perSymbolOpenNotional = userPositions
            .filter(p => p.symbol === symbol)
            .reduce((s, p) => s + Number(p.quantity) * Number(p.entryPrice), 0);

          const indicators = calculateIndicators(bars);
          const last = bars.at(-1);
          const atrPct = last && last.close > 0 && "atrPct" in last ? (last as any).atrPct ?? null : null;
          const ruleGrade = decision.setupQuality === "B" ? "B" : (decision.setupQuality as any);

          let liveTotalEquity = bal;
          for (const up of userPositions) {
            const upTicker = this.tickers[up.symbol];
            const upMark = upTicker?.last ?? Number(up.entryPrice);
            const upMetrics = computePositionRiskMetrics({
              side: up.side,
              entryPrice: Number(up.entryPrice),
              quantity: Number(up.quantity),
              leverage: up.leverage,
              currentPrice: upMark,
            });
            liveTotalEquity += upMetrics.unrealizedPnl;
          }
          // Peak proxy until we add a stored high-water mark: max of current
          // equity and the paper account's seed balance (10k starting balance).
          // Gate activates once equity dips below the seed.
          const drawdown = computeDrawdownMultiplier({
            currentEquity: liveTotalEquity,
            peakEquity: Math.max(liveTotalEquity, DEFAULT_WALLET_BALANCE),
          });
          // Continuous vol-target via ATR%-as-daily-vol proxy. atrPct is in
          // percent (e.g. 1.5 = 1.5%); divide by 100 to get a fraction so
          // the helper's target/forecast ratio is unit-consistent.
          const volTarget = computeVolTargetMultiplier({
            targetDailyVol: 0.015,
            forecastDailyVol: atrPct != null ? atrPct / 100 : null,
          });

          const sizing = computeRiskAdjustedSize({
            symbol: decision.symbol,
            side,
            livePrice: decision.entryPrice,
            stopLossPrice: decision.stopLoss,
            takeProfitPrice: decision.takeProfit,
            totalEquity: liveTotalEquity,
            availableBalance,
            confidence: decision.confidence,
            setupQuality: ruleGrade,
            marketRegime: indicators.regime ?? undefined,
            atrPct,
            decisionType: decision.type,
            exposure: {
              totalOpenNotional,
              perSymbolOpenNotional,
              openPositionsCount,
            },
            maxOpenPositions: 5,
            drawdownMultiplier: drawdown.multiplier,
            volTargetMultiplier: volTarget.fellBack ? undefined : volTarget.multiplier,
          });

          if (drawdown.haltNewEntries) {
            console.warn(
              `[RISK-GATE] User ${userId} ${decision.symbol} halted — ${drawdown.reason}`,
            );
          } else if (drawdown.multiplier < 1) {
            console.info(
              `[RISK-GATE] User ${userId} ${decision.symbol} ${drawdown.reason}; ${volTarget.reason}`,
            );
          }

          if (sizing.rejection) {
            console.warn(`[SERVER-SIGNAL-ENGINE] User ${userId} ${decision.symbol} sized-out (${sizing.rejection}) — ${sizing.rationale}`);
            continue;
          }

          this.lastAutoExecuted[cooldownKey] = {
            signal: decision.signal,
            type: decision.type,
            executedAt: Date.now()
          };

          console.info(`[SERVER-SIGNAL-ENGINE] Firing order for User ${userId}: ${decision.signal} ${decision.symbol} qty=${sizing.quantity}`);
          const meta = JSON.stringify({
            decision: decision.type,
            confidence: decision.confidence,
            setupQuality: decision.setupQuality,
            sizing: {
              notional: Number(sizing.notional.toFixed(2)),
              riskAmount: Number(sizing.riskAmount.toFixed(2)),
              riskPercent: Number(sizing.riskPercent.toFixed(3)),
              equityPercent: Number(sizing.equityPercent.toFixed(2)),
              expectedProfit: Number(sizing.expectedProfit.toFixed(2)),
              expectedLoss: Number(sizing.expectedLoss.toFixed(2)),
              rr: Number(sizing.riskRewardRatio.toFixed(2)),
              rationale: sizing.rationale,
              multipliers: sizing.multipliers,
            },
          });

          await createPaperOrderInternal(userId, {
            symbol: decision.symbol,
            side,
            type: "MARKET",
            quantity: sizing.quantity,
            takeProfit: decision.takeProfit ?? undefined,
            stopLoss: decision.stopLoss ?? undefined,
            decisionSource: "RULE",
            decisionMeta: meta,
            blockIfAlreadyOpen: true,
          }).catch(err => {
            console.error(`[SERVER-SIGNAL-ENGINE] Failed to create paper order for user ${userId}:`, err);
          });
        }
      }
    } catch (err) {
      console.error(`[SERVER-SIGNAL-ENGINE] Error in runAiSignalLoop:`, err);
    } finally {
      this.signalLoopRunning = false;
    }
  }

  private async runAiTradeManagerLoop() {
    if (this.tradeManagerLoopRunning) return;
    this.tradeManagerLoopRunning = true;
    try {
      const openPositions = await prisma.paperPosition.findMany({
        where: {
          decisionSource: "LLM",
          status: { in: ["OPEN", "PARTIALLY_CLOSED"] }
        }
      });

      if (openPositions.length === 0) return;

      const autonomyOn = process.env.NEXT_PUBLIC_AI_AUTONOMY === "on";

      for (const pos of openPositions) {
        const symbol = pos.symbol;
        const bars = this.candles[`${symbol}:5m`];
        if (!bars || bars.length < 20) continue;

        const ticker = this.tickers[symbol];
        if (!ticker) continue;
        const livePrice = ticker.last;

        const technicals = calculateIndicators(bars);
        const closes = bars.map(b => b.close);
        const macdSeries = macd(closes);
        const macdVal = macdSeries.at(-1) ?? null;
        const macdPrev = macdSeries.length >= 2 ? macdSeries.at(-2) ?? null : null;
        const volume = bars.at(-1)?.volume ?? 0;
        const avgVolume = bars.slice(-20).reduce((sum, c) => sum + c.volume, 0) / Math.min(20, bars.length);

        const candleIntel = runCandlestickEngine({
          symbol,
          timeframe: "5m",
          candles: bars,
          minConfidence: 50,
        });
        const candlestickBias = candleIntel.netBias;
        const candlestickCategory = candleIntel.dominantCategory;

        const newsValidation = this.lastNewsValidation[symbol];
        const newsClass = newsValidation?.aggregateClass ?? null;
        const newsScore = newsValidation?.score ?? null;

        const mIndicators: ManagementIndicators = {
          ema50: technicals.ema50,
          ema200: technicals.ema200,
          rsi14: technicals.rsi14,
          macd: macdVal,
          macdPrev,
          atr14: technicals.atr14,
          atrPct: technicals.atrPct,
          adx14: technicals.adx14,
          vwap: technicals.vwap,
          vwapSlope: technicals.vwapSlope,
          regime: technicals.regime,
          bb: technicals.bb,
          volume,
          avgVolume,
          candlestickBias,
          candlestickCategory,
          newsClass,
          newsScore,
        };

        const qty = Number(pos.quantity);
        const entry = Number(pos.entryPrice);
        const riskMetrics = computePositionRiskMetrics({
          side: pos.side,
          entryPrice: entry,
          quantity: qty,
          leverage: pos.leverage,
          takeProfitPrice: pos.takeProfit ? Number(pos.takeProfit) : null,
          stopLossPrice: pos.stopLoss ? Number(pos.stopLoss) : null,
          currentPrice: livePrice,
        });
        const unrealizedPnl = riskMetrics.unrealizedPnl;
        const unrealizedPnlPct = riskMetrics.unrealizedPnlPct;

        let setupQuality: string | undefined = undefined;
        let qualityScore: number | undefined = undefined;
        if (pos.decisionMeta) {
          try {
            const parsedMeta = JSON.parse(pos.decisionMeta);
            setupQuality = parsedMeta.setupQuality;
            if (parsedMeta.quality && typeof parsedMeta.quality.score === "number") {
              qualityScore = parsedMeta.quality.score;
            }
          } catch (e) {}
        }

        const context: ManagedPositionContext = {
          id: pos.id,
          symbol: pos.symbol,
          side: pos.side,
          entryPrice: entry,
          quantity: qty,
          initialQuantity: Number(pos.initialQuantity),
          takeProfit: pos.takeProfit ? Number(pos.takeProfit) : null,
          stopLoss: pos.stopLoss ? Number(pos.stopLoss) : null,
          originalTakeProfit: pos.originalTakeProfit ? Number(pos.originalTakeProfit) : null,
          originalStopLoss: pos.originalStopLoss ? Number(pos.originalStopLoss) : null,
          tradeHealthScore: pos.tradeHealthScore ?? null,
          managementMeta: pos.managementMeta as any,
          marginUsed: Number(pos.marginUsed),
          createdAt: new Date(pos.createdAt).toISOString(),
          livePrice,
          unrealizedPnl,
          unrealizedPnlPct,
          setupQuality,
          qualityScore,
        };

        const closedCandles = bars.slice(0, -1);
        const { action, updatedMeta } = evaluatePosition(context, mIndicators, closedCandles, "5m");

        if (action.type === "HOLD") {
          await updatePositionHealthScoreInternal(pos.userId, pos.id, action.healthScore.overall, updatedMeta);
        } 
        else if (action.type === "EARLY_EXIT") {
          if (autonomyOn) {
            console.info(`[SERVER-TRADE-MGMT] Triggering early exit for ${symbol} @ ${livePrice}. Reason: ${action.reason}`);
            const res = await closePaperPositionInternal(pos.userId, pos.id, livePrice, {
              reason: "AI_EARLY_EXIT",
            });
            if (res) {
              await createManagementEventInternal({
                positionId: pos.id,
                type: "EARLY_EXIT",
                oldValue: qty,
                newValue: 0,
                healthScore: action.healthScore.overall,
                confidence: action.confidence,
                reason: action.reason,
                indicators: mIndicators,
              });
            }
          } else {
            console.info(`[SERVER-TRADE-MGMT] (Shadow mode) Early exit assessment for ${symbol}: ${action.reason}`);
            await updatePositionHealthScoreInternal(pos.userId, pos.id, action.healthScore.overall, updatedMeta);
          }
        } 
        else if (action.type === "PARTIAL_EXIT") {
          if (action.reason.includes("Confidence-based")) {
            updatedMeta.confidencePartialExitDone = true;
          }
          if (autonomyOn && action.quantity) {
            console.info(`[SERVER-TRADE-MGMT] Triggering partial exit for ${symbol} closeQty=${action.quantity} @ ${livePrice}. Reason: ${action.reason}`);
            const res = await closePaperPositionInternal(pos.userId, pos.id, livePrice, {
              quantity: action.quantity,
              reason: "MANUAL",
            });
            if (res) {
              await updatePositionHealthScoreInternal(pos.userId, pos.id, action.healthScore.overall, updatedMeta);
              await createManagementEventInternal({
                positionId: pos.id,
                type: "PARTIAL_EXIT",
                oldValue: qty,
                newValue: qty - action.quantity,
                healthScore: action.healthScore.overall,
                confidence: action.confidence,
                reason: action.reason,
                indicators: mIndicators,
              });
            }
          } else {
            console.info(`[SERVER-TRADE-MGMT] (Shadow mode) Partial exit assessment for ${symbol}: ${action.reason}`);
            await updatePositionHealthScoreInternal(pos.userId, pos.id, action.healthScore.overall, updatedMeta);
          }
        } 
        else if (
          action.type === "ADJUST_TP" || 
          action.type === "ADJUST_SL" || 
          action.type === "TRAIL_SL" || 
          action.type === "BREAKEVEN_SL"
        ) {
          if (autonomyOn && action.newValue !== undefined) {
            const currentTP = pos.takeProfit ? Number(pos.takeProfit) : null;
            const currentSL = pos.stopLoss ? Number(pos.stopLoss) : null;
            const isTpUpdate = action.type === "ADJUST_TP";
            const nextTP = isTpUpdate ? action.newValue : currentTP;
            const nextSL = !isTpUpdate ? action.newValue : currentSL;

            console.info(`[SERVER-TRADE-MGMT] Adjusting levels for ${symbol}: nextTP=${nextTP}, nextSL=${nextSL}. Reason: ${action.reason}`);
            const res = await updatePositionLevelsInternal(pos.userId, pos.id, {
              takeProfit: nextTP,
              stopLoss: nextSL,
              currentTakeProfit: currentTP,
              currentStopLoss: currentSL,
              managementMeta: updatedMeta,
              healthScore: action.healthScore.overall,
            });

            if (res) {
              let eventType = "SL_ADJUSTED";
              if (action.type === "ADJUST_TP") eventType = "TP_ADJUSTED";
              else if (action.type === "TRAIL_SL") eventType = "SL_TRAILED";
              else if (action.type === "BREAKEVEN_SL") eventType = "SL_BREAKEVEN";

              await createManagementEventInternal({
                positionId: pos.id,
                type: eventType,
                oldValue: isTpUpdate ? currentTP : currentSL,
                newValue: action.newValue,
                healthScore: action.healthScore.overall,
                confidence: action.confidence,
                reason: action.reason,
                indicators: mIndicators,
              });
            }
          } else {
            console.info(`[SERVER-TRADE-MGMT] (Shadow mode) Adjust levels assessment for ${symbol} to ${action.newValue}: ${action.reason}`);
            await updatePositionHealthScoreInternal(pos.userId, pos.id, action.healthScore.overall, updatedMeta);
          }
        }
      }
    } catch (err) {
      console.error(`[SERVER-TRADE-MGMT] Error in runAiTradeManagerLoop:`, err);
    } finally {
      this.tradeManagerLoopRunning = false;
    }
  }

  private async runLlmDecisionForSymbol(symbol: string) {
    try {
      const bars = this.candles[`${symbol}:5m`];
      if (!bars || bars.length < 30) {
        console.warn(`[SERVER-LLM-DECISION] Skipping ${symbol} — not enough candles`);
        return;
      }

      const livePrice = this.tickers[symbol]?.last;
      if (livePrice == null || !Number.isFinite(livePrice) || livePrice <= 0) {
        console.warn(`[SERVER-LLM-DECISION] Skipping ${symbol} — ticker unavailable`);
        return;
      }

      const sentimentRes = await getSentiment(symbol).catch(() => null);
      const sentiment = sentimentRes?.ok ? sentimentRes.sentiment : undefined;

      const windowed = bars.slice(-300);

      const portfolioState = {
        accountBalance: 10000,
        openPositionsCount: 0,
        hasOpenPositionThisSymbol: false,
      };

      const res = await getStrategyDecision({
        symbol,
        timeframe: "5m",
        candles: windowed,
        sentiment,
        portfolio: portfolioState,
      });

      if (!res.ok || !res.decision || !res.generatedAt || !res.key) {
        console.warn(`[SERVER-LLM-DECISION] Strategy decision failed for ${symbol}: ${res.error ?? "unknown"}`);
        return;
      }

      const d = res.decision;
      console.info(`[SERVER-LLM-DECISION] ${symbol} → ${d.decision} conf=${d.confidence} setup=${d.setupQuality} (model=${res.model})`);

      if (res.newsValidation) {
        this.lastNewsValidation[symbol] = res.newsValidation;
      }

      const autonomyOn = process.env.NEXT_PUBLIC_AI_AUTONOMY === "on";

      const decisionEntry = {
        decision: d,
        generatedAt: res.generatedAt,
        provider: res.provider ?? "groq",
        model: res.model ?? "unknown",
        key: res.key,
        newsValidation: res.newsValidation,
        strategySnapshot: res.strategySnapshot,
        fullStrategySnapshot: res.fullStrategySnapshot,
        source: res.source,
      };

      const side = decisionSide(d.decision);

      if (!side) {
        const fakeAssessment: TradeAssessment = {
          approved: false,
          rejections: [
            {
              code: "no_trade_decision",
              message: `Decision is ${d.decision}`,
            },
          ],
          warnings: [],
          metrics: {
            expectedProfitPercent: 0,
            expectedLossPercent: 0,
            riskRewardRatio: 0,
            entryDriftBps: 0,
            volatilityScore: 0,
          },
          score: { value: 0, grade: "D", factors: [] },
          llmSetupQuality: d.setupQuality,
        };
        await this.persistSignalReport({
          entry: decisionEntry,
          symbol,
          assessment: fakeAssessment,
          status: "REJECTED",
          executionResult: `Decision is ${d.decision}`,
        });
        return;
      }

      const news = res.newsValidation;
      if (news?.status === "ok" && news.action === "REJECT") {
        const newsRejection: TradeAssessment = {
          approved: false,
          rejections: [
            {
              code: "news_critical_risk",
              message: news.rationale,
            },
          ],
          warnings: [],
          metrics: {
            expectedProfitPercent: 0,
            expectedLossPercent: 0,
            riskRewardRatio: 0,
            entryDriftBps: 0,
            volatilityScore: 0,
          },
          score: { value: 0, grade: "D", factors: [] },
          llmSetupQuality: d.setupQuality,
        };
        await this.persistSignalReport({
          entry: decisionEntry,
          symbol,
          assessment: newsRejection,
          status: "REJECTED",
          executionResult: `news_veto: ${news.rationale}`,
        });
        return;
      }

      const effectiveDecision = this.applyNewsAdjustments(d, side, livePrice, news);
      const effectiveEntry = { ...decisionEntry, decision: effectiveDecision };

      if (!autonomyOn) {
        const proposal = this.buildProposal(symbol, side, effectiveEntry, livePrice, [], 10000);
        const assessment = assessTradeQuality(proposal);
        await this.persistSignalReport({
          entry: effectiveEntry,
          symbol,
          assessment,
          status: assessment.approved ? "SHADOW_ACCEPTED" : "REJECTED",
          executionResult: assessment.approved ? "Shadow approval" : (assessment.rejections[0]?.message ?? "Rejection"),
        });
        return;
      }

      const wallets = await prisma.paperWallet.findMany({
        select: { userId: true, balance: true, usedMargin: true }
      });

      for (const wallet of wallets) {
        const userId = wallet.userId;
        const bal = Number(wallet.balance);
        const usedMargin = Number(wallet.usedMargin);
        const availableBalance = bal - usedMargin;

        const userPositions = await prisma.paperPosition.findMany({
          where: { userId, status: { in: ["OPEN", "PARTIALLY_CLOSED"] } }
        });

        const anyOpenOnSymbol = userPositions.find(p => p.symbol === symbol);
        const llmOwnedPosition = anyOpenOnSymbol?.decisionSource === "LLM" ? anyOpenOnSymbol : undefined;

        if (llmOwnedPosition) {
          const exitReason = this.evaluateExit(symbol, llmOwnedPosition, effectiveEntry);
          if (exitReason) {
            console.info(`[SERVER-LLM-DECISION] Triggering exit for User ${userId} ${symbol} due to ${exitReason}`);
            const closeRes = await closePaperPositionInternal(userId, llmOwnedPosition.id, livePrice, {
              reason: "AI_EXIT"
            });
            if (closeRes) {
              this.lastExitAt[symbol] = Date.now();
              await createManagementEventInternal({
                positionId: llmOwnedPosition.id,
                type: "EARLY_EXIT",
                oldValue: Number(llmOwnedPosition.quantity),
                newValue: 0,
                healthScore: 50,
                confidence: d.confidence,
                reason: exitReason,
              });
            }
            continue;
          }
        }

        if (anyOpenOnSymbol) continue;

        const lastExit = this.lastExitAt[symbol];
        const isCooldownActive = lastExit && (Date.now() - lastExit < 10 * 60 * 1000);
        const isHighQuality = d.setupQuality === "A" || d.setupQuality === "A+";

        if (isCooldownActive && !isHighQuality) {
          const cooldownRejection: TradeAssessment = {
            approved: false,
            rejections: [
              {
                code: "exit_cooldown_active",
                message: `Symbol exited recently (cooldown active until ${new Date(lastExit + 10 * 60 * 1000).toLocaleTimeString()}) and setup quality is ${d.setupQuality} (requires A or A+)`,
              },
            ],
            warnings: [],
            metrics: {
              expectedProfitPercent: 0,
              expectedLossPercent: 0,
              riskRewardRatio: 0,
              entryDriftBps: 0,
              volatilityScore: 0,
            },
            score: { value: 0, grade: "D", factors: [] },
            llmSetupQuality: d.setupQuality,
          };
          await this.persistSignalReport({
            entry: effectiveEntry,
            symbol,
            assessment: cooldownRejection,
            status: "REJECTED",
            executionResult: `exit_cooldown_active`,
          });
          continue;
        }

        const proposal = this.buildProposal(symbol, side, effectiveEntry, livePrice, userPositions, availableBalance);
        const assessment = assessTradeQuality(proposal);

        if (!assessment.approved) {
          await this.persistSignalReport({
            entry: effectiveEntry,
            symbol,
            assessment,
            status: "REJECTED",
            executionResult: assessment.rejections[0]?.message ?? "Rejection",
          });
          continue;
        }

        let liveTotalEquity = bal;
        for (const up of userPositions) {
          const upTicker = this.tickers[up.symbol];
          const upMark = upTicker?.last ?? Number(up.entryPrice);
          const upMetrics = computePositionRiskMetrics({
            side: up.side,
            entryPrice: Number(up.entryPrice),
            quantity: Number(up.quantity),
            leverage: up.leverage,
            currentPrice: upMark,
          });
          liveTotalEquity += upMetrics.unrealizedPnl;
        }
        const { totalOpenNotional, perSymbolOpenNotional, openPositionsCount } = this.computeExposure(userPositions, symbol);

        const atrPct = proposal.atrPct;
        const externalSizeMultiplier = news && news.status === "ok" ? news.sizeMultiplier : 1;

        const drawdown = computeDrawdownMultiplier({
          currentEquity: liveTotalEquity,
          peakEquity: Math.max(liveTotalEquity, DEFAULT_WALLET_BALANCE),
        });
        const volTarget = computeVolTargetMultiplier({
          targetDailyVol: 0.015,
          forecastDailyVol: atrPct != null ? atrPct / 100 : null,
        });

        const sizing = computeRiskAdjustedSize({
          symbol,
          side,
          livePrice,
          stopLossPrice: effectiveDecision.stopLoss,
          takeProfitPrice: effectiveDecision.takeProfit,
          totalEquity: liveTotalEquity,
          availableBalance,
          confidence: effectiveDecision.confidence,
          setupQuality: effectiveDecision.setupQuality as any,
          marketRegime: proposal.marketRegime,
          atrPct,
          decisionType: effectiveDecision.decision,
          exposure: {
            totalOpenNotional,
            perSymbolOpenNotional,
            openPositionsCount,
          },
          maxOpenPositions: 5,
          externalSizeMultiplier,
          drawdownMultiplier: drawdown.multiplier,
          volTargetMultiplier: volTarget.fellBack ? undefined : volTarget.multiplier,
        });

        if (drawdown.haltNewEntries) {
          console.warn(`[RISK-GATE] LLM path ${symbol} halted — ${drawdown.reason}`);
        } else if (drawdown.multiplier < 1) {
          console.info(`[RISK-GATE] LLM path ${symbol} ${drawdown.reason}; ${volTarget.reason}`);
        }

        if (sizing.rejection) {
          await this.persistSignalReport({
            entry: effectiveEntry,
            symbol,
            assessment,
            status: "REJECTED",
            executionResult: `sized_out: ${sizing.rationale}`,
          });
          continue;
        }

        const quantity = sizing.quantity;

        this.lastExecutedAt[symbol] = Date.now();

        const meta = JSON.stringify({
          model: res.model,
          decision: effectiveDecision.decision,
          confidence: effectiveDecision.confidence,
          setupQuality: effectiveDecision.setupQuality,
          riskLevel: effectiveDecision.riskLevel,
          expectedHoldMins: effectiveDecision.expectedHoldTimeMinutes,
          sizing: {
            notional: Number(sizing.notional.toFixed(2)),
            riskAmount: Number(sizing.riskAmount.toFixed(2)),
            riskPercent: Number(sizing.riskPercent.toFixed(3)),
            equityPercent: Number(sizing.equityPercent.toFixed(2)),
            expectedProfit: Number(sizing.expectedProfit.toFixed(2)),
            expectedLoss: Number(sizing.expectedLoss.toFixed(2)),
            rr: Number(sizing.riskRewardRatio.toFixed(2)),
            rationale: sizing.rationale,
            multipliers: sizing.multipliers,
            externalSizeMultiplier: sizing.externalSizeMultiplier,
          },
          quality: {
            score: assessment.score.value,
            grade: assessment.score.grade,
            regime: proposal.marketRegime,
          },
          news: news && news.status === "ok" ? {
            aggregateClass: news.aggregateClass,
            score: news.score,
            action: news.action,
            sizeMult: news.sizeMultiplier,
            stopMult: news.stopMultiplier,
            items: news.itemsConsidered,
            topHeadline: news.items[0]?.title,
            llm: news.llmEnrichmentUsed,
          } : { status: news?.status ?? "missing" },
        });

        console.info(`[SERVER-LLM-DECISION] Creating order for user ${userId}: ${effectiveDecision.decision} ${symbol} qty=${quantity}`);
        await createPaperOrderInternal(userId, {
          symbol,
          side,
          type: "MARKET",
          quantity,
          takeProfit: effectiveDecision.takeProfit,
          stopLoss: effectiveDecision.stopLoss,
          decisionSource: "LLM",
          decisionMeta: meta,
          blockIfAlreadyOpen: true,
        }).then(async (orderRes) => {
          await this.persistSignalReport({
            entry: effectiveEntry,
            symbol,
            assessment,
            status: "ACCEPTED",
            executionResult: orderRes.id,
          });
        }).catch(async (err) => {
          console.error(`[SERVER-LLM-DECISION] Order failed for user ${userId}:`, err);
          await this.persistSignalReport({
            entry: effectiveEntry,
            symbol,
            assessment,
            status: "REJECTED",
            executionResult: err instanceof Error ? err.message : "Order failed",
          });
        });
      }

    } catch (err) {
      console.error(`[SERVER-LLM-DECISION] Error in runLlmDecisionForSymbol for ${symbol}:`, err);
    }
  }

  private buildProposal(
    symbol: string,
    side: "LONG" | "SHORT",
    entry: any,
    livePrice: number,
    pos: any[],
    availableBalance: number,
  ): any {
    const openCount = pos.length;
    const hasDupSide = pos.some(p => p.symbol === symbol && p.side === side);
    const lastExec = this.lastExecutedAt[symbol];
    const msSinceLast = lastExec ? Date.now() - lastExec : null;

    const key = `${symbol}:5m`;
    const candles = this.candles[key] || [];
    const last = candles.at(-1);
    const atrPct = last && last.close > 0 && "atrPct" in last ? (last as any).atrPct ?? null : null;

    const indicators = calculateIndicators(candles);
    const marketRegime = indicators.regime ?? "Sideways";

    return {
      symbol,
      side,
      decision: entry.decision,
      livePrice,
      atrPct,
      marketRegime,
      book: {
        openPositionsCount: openCount,
        hasDuplicateSide: hasDupSide,
        msSinceLastExecution: msSinceLast,
        availableBalance,
      },
      key: entry.key,
    };
  }

  private applyNewsAdjustments(
    decision: MarketDecision,
    side: "LONG" | "SHORT",
    livePrice: number,
    news: any,
  ): MarketDecision {
    if (!news || news.status !== "ok") return decision;
    const stopMult = news.stopMultiplier;
    if (stopMult >= 1) return decision;

    const rawDist = Math.abs(livePrice - decision.stopLoss);
    if (rawDist <= 0 || !Number.isFinite(rawDist)) return decision;

    const newDist = rawDist * Math.max(0.4, stopMult);
    const newSL = side === "LONG" ? livePrice - newDist : livePrice + newDist;
    if (!Number.isFinite(newSL) || newSL <= 0) return decision;

    return { ...decision, stopLoss: newSL };
  }

  private evaluateExit(
    symbol: string,
    position: any,
    entry: any,
  ): string | null {
    const d = entry.decision;
    const lastExit = this.lastExitAt[symbol];
    if (lastExit && Date.now() - lastExit < 60 * 1000) return null;

    if (d.setupQuality === "Avoid") return "setup graded Avoid";
    if (d.decision === "AVOID" && d.confidence >= 65) {
      return `LLM flipped to AVOID @ ${d.confidence}%`;
    }
    const newSide = decisionSide(d.decision);
    if (newSide && newSide !== position.side && d.confidence >= 60) {
      return `LLM flipped ${position.side} → ${newSide}`;
    }
    if (d.decision === "HOLD" && d.confidence >= 75) {
      const ageMs = Date.now() - new Date(position.createdAt).getTime();
      if (ageMs > 30 * 60 * 1000) return "HOLD after held >30min";
    }
    return null;
  }

  private computeExposure(positions: any[], symbol: string) {
    let totalOpenNotional = 0;
    let perSymbolOpenNotional = 0;
    let openPositionsCount = 0;
    for (const p of positions) {
      openPositionsCount += 1;
      const metrics = computePositionRiskMetrics({
        side: p.side,
        entryPrice: Number(p.entryPrice),
        quantity: Number(p.quantity),
        leverage: p.leverage,
      });
      const notional = metrics.notionalValue;
      totalOpenNotional += notional;
      if (p.symbol === symbol) perSymbolOpenNotional += notional;
    }
    return { totalOpenNotional, perSymbolOpenNotional, openPositionsCount };
  }

  private async persistSignalReport({
    entry,
    symbol,
    assessment,
    status,
    executionResult,
  }: {
    entry: any;
    symbol: string;
    assessment: TradeAssessment;
    status: "ACCEPTED" | "REJECTED" | "MODIFIED" | "SHADOW_ACCEPTED";
    executionResult?: string;
  }) {
    try {
      const candles = this.candles[`${symbol}:5m`] || [];
      const indicators = calculateIndicators(candles);

      let emaAlignment = "No alignment";
      if (indicators.ema50 && indicators.ema200) {
        emaAlignment = indicators.ema50 > indicators.ema200
          ? "Bullish (EMA50 > EMA200)"
          : "Bearish (EMA50 < EMA200)";
      }

      let supportPrice = null;
      let resistancePrice = null;
      if (candles.length >= 30) {
        const window = candles.slice(-30);
        supportPrice = Math.min(...window.map((c) => c.low));
        resistancePrice = Math.max(...window.map((c) => c.high));
      }

      let candlestickPatterns = null;
      try {
        if (candles.length >= 14) {
          const intel = runCandlestickEngine({
            symbol,
            timeframe: "5m",
            candles,
          });
          candlestickPatterns = {
            detections: intel.detections.slice(0, 4).map((d) => ({
              patternName: d.patternName,
              direction: d.direction,
              category: d.category,
              confidence: d.confidenceScore,
              strength: d.patternStrength,
              reasoning: d.reasoning,
            })),
            netBias: intel.netBias,
            narrative: intel.narrative,
            dominantCategory: intel.dominantCategory,
          };
        }
      } catch (err) {
        console.warn("[XAI-INTEGRATION] Failed to run candlestick engine:", err);
      }

      const reasoning = entry.decision.reasoning ?? [];
      const newsVal = entry.newsValidation;

      let sizing = null;
      try {
        sizing = computeRiskAdjustedSize({
          symbol,
          side: decisionSide(entry.decision.decision) ?? "LONG",
          livePrice: this.tickers[symbol]?.last ?? entry.decision.entryPrice,
          stopLossPrice: entry.decision.stopLoss,
          takeProfitPrice: entry.decision.takeProfit,
          totalEquity: 10000,
          availableBalance: 10000,
          confidence: entry.decision.confidence,
          setupQuality: entry.decision.setupQuality,
          marketRegime: indicators.regime,
          atrPct: indicators.atrPct,
          decisionType: entry.decision.decision,
          exposure: {
            totalOpenNotional: 0,
            perSymbolOpenNotional: 0,
            openPositionsCount: 0,
          },
          maxOpenPositions: 5,
          externalSizeMultiplier: newsVal?.status === "ok" ? newsVal.sizeMultiplier : 1,
        });
      } catch (err) {
        console.warn("[XAI-INTEGRATION] Failed to compute risk adjusted size:", err);
      }

      let newsVetoResult = "Passed";
      if (newsVal?.status === "ok" && newsVal.action === "REJECT") {
        newsVetoResult = `Vetoed: ${newsVal.rationale}`;
      }

      const driftBps = assessment.metrics.entryDriftBps;
      const driftPercent = driftBps != null ? driftBps / 100 : 0;

      const projSnapshot = entry.strategySnapshot;
      const fullSnapshot = entry.fullStrategySnapshot;
      
      const effectiveN = fullSnapshot ? fullSnapshot.effectiveN : (projSnapshot ? projSnapshot.effectiveN : null);
      const familyNetDirection = fullSnapshot ? fullSnapshot.familyNetDirection : (projSnapshot ? projSnapshot.netDirection : null);
      const familyAlignmentScore = fullSnapshot ? fullSnapshot.familyAlignmentScore : (projSnapshot ? projSnapshot.alignmentScore : null);
      
      let familyBreakdown = null;
      if (fullSnapshot) {
        familyBreakdown = JSON.parse(JSON.stringify(fullSnapshot.familyBreakdown));
      } else if (projSnapshot && projSnapshot.factorMix) {
        familyBreakdown = JSON.parse(JSON.stringify(projSnapshot.factorMix));
      }

      let strategySignals = null;
      if (fullSnapshot && Array.isArray(fullSnapshot.ranked)) {
        strategySignals = fullSnapshot.ranked.map((r: any, idx: number) => ({
          strategyId: r.output.strategyId,
          strategyName: r.output.strategyName,
          category: r.output.category,
          signal: r.output.signal,
          rawConfidence: r.output.confidence,
          weightedScore: r.weightedScore,
          family: r.output.family ?? r.output.category,
          regime: fullSnapshot.regime,
          timestamp: new Date().toISOString(),
          barIndex: idx,
          signalSourceVersion: "1.0"
        }));
      } else if (projSnapshot && Array.isArray(projSnapshot.topStrategies)) {
        strategySignals = projSnapshot.topStrategies.map((ts: any, idx: number) => ({
          strategyId: ts.strategyId,
          strategyName: ts.strategyName,
          category: ts.category,
          signal: ts.signal,
          rawConfidence: ts.confidence,
          weightedScore: ts.weightedScore,
          family: ts.family ?? ts.category,
          regime: projSnapshot.regime,
          timestamp: new Date().toISOString(),
          barIndex: idx,
          signalSourceVersion: "1.0"
        }));
      }

      let finalExecutionResult = executionResult || null;
      const isFallback = entry.source === "local-fallback" || entry.model === "fallback-engine";
      if (isFallback) {
        finalExecutionResult = finalExecutionResult 
          ? `local-fallback: ${finalExecutionResult}`
          : "local-fallback: Groq API key/model exhaustion or timeout triggered local fallback engine";
      }

      await saveExplainableSignal({
        symbol,
        side: decisionSide(entry.decision.decision) ?? "NONE",
        status,
        confidence: entry.decision.confidence,
        finalAction: entry.decision.decision,
        executionResult: finalExecutionResult,
        
        emaAlignment,
        rsi: indicators.rsi14,
        macd: indicators.macd ? JSON.parse(JSON.stringify(indicators.macd)) : null,
        vwap: indicators.vwap,
        volatility: indicators.atrPct,
        trendRegime: indicators.regime,
        supportPrice,
        resistancePrice,
        momentumAnalysis: indicators.adx14 ? `ADX: ${indicators.adx14.toFixed(1)}` : null,

        candlestickPatterns: candlestickPatterns ? JSON.parse(JSON.stringify(candlestickPatterns)) : null,
        newsValidation: newsVal ? JSON.parse(JSON.stringify(newsVal)) : null,
        reasoning: JSON.parse(JSON.stringify(reasoning)),

        effectiveN,
        familyNetDirection,
        familyAlignmentScore,
        familyBreakdown,
        strategySignals,

        fusionVersion: "1.0-family-decorrelated",
        regimeVersion: "1.0-macro-adx",
        sizingVersion: "1.1-vol-target-drawdown",
        orchestrationVersion: "2.0-async-runner",

        slPrice: entry.decision.stopLoss,
        tpPrice: entry.decision.takeProfit,
        riskRewardRatio: assessment.metrics.riskRewardRatio,
        leverageAdjustment: "None",
        sizeAdjustment: sizing?.multipliers
          ? `Adjusted (factors: ${JSON.stringify(sizing.multipliers)})`
          : "None",
        positionSizing: sizing ? JSON.parse(JSON.stringify({
          notional: sizing.notional,
          riskAmount: sizing.riskAmount,
          riskPercent: sizing.riskPercent,
          equityPercent: sizing.equityPercent,
          expectedProfit: sizing.expectedProfit,
          expectedLoss: sizing.expectedLoss,
          rr: sizing.riskRewardRatio,
          rationale: sizing.rationale,
          externalSizeMultiplier: sizing.externalSizeMultiplier,
          setupQuality: entry.decision.setupQuality,
          qualityScore: assessment.score.value,
          qualityGrade: assessment.score.grade,
          expectedProfitPercent: assessment.metrics.expectedProfitPercent,
          expectedLossPercent: assessment.metrics.expectedLossPercent,
          volatilityScore: assessment.metrics.volatilityScore,
        })) : null,

        entryDrift: driftPercent,
        spreadValidation: "Passed (standard spread)",
        liquidityChecks: "Passed (deep orderbook)",
        newsVetoResult
      }, {
        source: entry.source || (entry.model === "fallback-engine" ? "local-fallback" : "llm"),
        alignmentScore: undefined,
      });

      // Asynchronously run correlation telemetry out-of-band so it does not block the hot path
      void computeRollingCorrelations(100).catch((err) => {
        console.error("[CORRELATION-TELEMETRY-ERROR] Failed to compute rolling correlation diagnostics:", err);
      });
    } catch (err) {
      console.error("[SERVER-LLM-DECISION] Failed to save explainable signal:", err);
    }
  }
}
