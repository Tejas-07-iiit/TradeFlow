import { prisma } from "@/lib/prisma";
import { StrategyRegistry } from "@/strategy-core/registry";
import "@/strategies"; // bootstrap strategies

export interface StrategyScorecard {
  strategyId: string;
  strategyName: string;
  category: string;
  family: string;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  avgPnl: number;
  sharpeProxy: number;
  maxDrawdownProxy: number;
  activationCount: number;
  lifecycleState: "ACTIVE" | "DEGRADED" | "QUARANTINED" | "DISABLED" | "EXPERIMENTAL";
  regimePerformance: Record<string, { winRate: number; totalPnl: number; tradesCount: number }>;
  calibration: {
    bucket: string;
    totalSignals: number;
    alignedWins: number;
    calibrationRate: number;
  }[];
}

function stdDev(values: number[]): number {
  if (values.length <= 1) return 0;
  const avg = values.reduce((s, v) => s + v, 0) / values.length;
  const sumSq = values.reduce((s, v) => s + Math.pow(v - avg, 2), 0);
  return Math.sqrt(sumSq / (values.length - 1));
}

function calculateMaxDrawdown(pnls: number[]): number {
  let peak = 0;
  let cumulative = 0;
  let maxDd = 0;
  for (const p of pnls) {
    cumulative += p;
    if (cumulative > peak) {
      peak = cumulative;
    }
    const dd = peak - cumulative;
    if (dd > maxDd) {
      maxDd = dd;
    }
  }
  return maxDd;
}

/**
 * Computes Strategy Scorecards by querying database records.
 * Matches closed trades to the specific strategy snapshot configurations that recommended them.
 */
export async function computeStrategyScorecards(userId?: string): Promise<StrategyScorecard[]> {
  // 1. Fetch trades
  const trades = await prisma.tradeHistory.findMany({
    where: userId ? { userId } : undefined,
    orderBy: { closedAt: "asc" }, // Ascending for time-sequence drawdown calculation
  });

  // 2. Fetch explainable signals that are accepted
  const signals = await prisma.explainableSignal.findMany({
    where: {
      status: { in: ["ACCEPTED", "SHADOW_ACCEPTED"] },
    },
    orderBy: { timestamp: "desc" },
  });

  // 3. Match TradeHistory to ExplainableSignals by symbol and timestamp closeness (within 60s)
  const tradeSignalMap = new Map<string, any>();
  for (const trade of trades) {
    const openedTime = new Date(trade.openedAt).getTime();
    const candidate = signals.find((sig) => {
      if (sig.symbol !== trade.symbol) return false;
      const sigTime = new Date(sig.timestamp).getTime();
      const diff = openedTime - sigTime;
      // Signal is generated just before order matches / fills (within 60s)
      return diff >= -5000 && diff <= 60000;
    });
    if (candidate) {
      tradeSignalMap.set(trade.id, candidate);
    }
  }

  // 4. Gather list of registered strategies
  const allStrategies = StrategyRegistry.all();
  const scorecards: StrategyScorecard[] = [];

  for (const strategy of allStrategies) {
    const strategyId = strategy.id;
    const family = strategy.family ?? "trend";
    const category = strategy.category;

    // Track statistics for this strategy
    const alignedTradesPnl: number[] = [];
    let wins = 0;
    let losses = 0;
    let totalPnl = 0;

    // Regime grouping
    const regimeGroups: Record<string, { totalPnl: number; wins: number; tradesCount: number }> = {};

    // Calibration grouping (by confidence bucket)
    const calibrationGroups: Record<string, { total: number; wins: number }> = {
      "< 60": { total: 0, wins: 0 },
      "60-70": { total: 0, wins: 0 },
      "70-80": { total: 0, wins: 0 },
      "80-90": { total: 0, wins: 0 },
      "90-100": { total: 0, wins: 0 },
    };

    let activationCount = 0;

    // Evaluate closed trade histories
    for (const trade of trades) {
      const sig = tradeSignalMap.get(trade.id);
      if (!sig || !sig.strategySignals) continue;

      // Extract JSON array
      const rawSignals = typeof sig.strategySignals === "string" 
        ? JSON.parse(sig.strategySignals) 
        : sig.strategySignals;
      
      if (!Array.isArray(rawSignals)) continue;

      // Find this strategy's vote in the snapshot
      const vote = rawSignals.find((v: any) => v.strategyId === strategyId);
      if (!vote) continue;

      // Increment total activation signals
      if (vote.signal === "BUY" || vote.signal === "SELL") {
        activationCount++;
      }

      // Check alignment: Did the strategy vote for the trade side?
      // trade.side = "LONG" -> strategy must vote "BUY"
      // trade.side = "SHORT" -> strategy must vote "SELL"
      const isAligned =
        (trade.side === "LONG" && vote.signal === "BUY") ||
        (trade.side === "SHORT" && vote.signal === "SELL");

      if (isAligned) {
        const pnl = Number(trade.pnl);
        alignedTradesPnl.push(pnl);
        totalPnl += pnl;
        if (pnl > 0) {
          wins++;
        } else {
          losses++;
        }

        // Aggregate regime performance
        const regime = sig.trendRegime || "Unknown";
        if (!regimeGroups[regime]) {
          regimeGroups[regime] = { totalPnl: 0, wins: 0, tradesCount: 0 };
        }
        regimeGroups[regime].totalPnl += pnl;
        regimeGroups[regime].tradesCount++;
        if (pnl > 0) {
          regimeGroups[regime].wins++;
        }

        // Calibration statistics
        const conf = vote.rawConfidence ?? vote.confidence ?? 0;
        let bucket = "< 60";
        if (conf >= 90) bucket = "90-100";
        else if (conf >= 80) bucket = "80-90";
        else if (conf >= 70) bucket = "70-80";
        else if (conf >= 60) bucket = "60-70";

        calibrationGroups[bucket].total++;
        if (pnl > 0) {
          calibrationGroups[bucket].wins++;
        }
      }
    }

    // Post-process metrics
    const totalTrades = wins + losses;
    const winRate = totalTrades > 0 ? wins / totalTrades : 0;
    const avgPnl = totalTrades > 0 ? totalPnl / totalTrades : 0;
    
    // Sharpe Proxy (Average PnL / SD of PnLs)
    const sd = stdDev(alignedTradesPnl);
    const sharpeProxy = sd > 0 ? avgPnl / sd : 0;

    // Drawdown
    const maxDrawdownProxy = calculateMaxDrawdown(alignedTradesPnl);

    // Regime details
    const regimePerformance: Record<string, { winRate: number; totalPnl: number; tradesCount: number }> = {};
    for (const [regime, info] of Object.entries(regimeGroups)) {
      regimePerformance[regime] = {
        winRate: info.tradesCount > 0 ? info.wins / info.tradesCount : 0,
        totalPnl: info.totalPnl,
        tradesCount: info.tradesCount,
      };
    }

    // Calibration details
    const calibration = Object.entries(calibrationGroups).map(([bucket, info]) => ({
      bucket,
      totalSignals: info.total,
      alignedWins: info.wins,
      calibrationRate: info.total > 0 ? info.wins / info.total : 0,
    }));

    // Lifecycle state determination:
    // ACTIVE, DEGRADED, QUARANTINED, DISABLED, EXPERIMENTAL
    let lifecycleState: StrategyScorecard["lifecycleState"] = "ACTIVE";
    if (!strategy.enabled) {
      lifecycleState = "DISABLED";
    } else if (totalTrades < 5) {
      lifecycleState = "EXPERIMENTAL";
    } else if (winRate < 0.40) {
      lifecycleState = "QUARANTINED";
    } else if (winRate < 0.45 || maxDrawdownProxy > 1500) {
      lifecycleState = "DEGRADED";
    }

    scorecards.push({
      strategyId,
      strategyName: strategy.name,
      category,
      family,
      totalTrades,
      wins,
      losses,
      winRate,
      totalPnl,
      avgPnl,
      sharpeProxy,
      maxDrawdownProxy,
      activationCount,
      lifecycleState,
      regimePerformance,
      calibration,
    });
  }

  // Sort scorecards by win rate descending, with disabled/experimental at bottom
  return scorecards.sort((a, b) => {
    if (a.lifecycleState === "DISABLED" && b.lifecycleState !== "DISABLED") return 1;
    if (b.lifecycleState === "DISABLED" && a.lifecycleState !== "DISABLED") return -1;
    return b.winRate - a.winRate;
  });
}
