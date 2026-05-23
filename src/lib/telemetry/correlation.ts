import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { StrategyRegistry } from "@/strategy-core/registry";
import "@/strategies";

export interface CorrelationPair {
  strategyA: string;
  strategyB: string;
  correlation: number;
}

export interface ConcentrationAlert {
  timestamp: Date;
  avgEffectiveN: number;
  message: string;
  severity: "info" | "warning" | "critical";
}

export interface CorrelationReport {
  timestamp: Date;
  rollingWindowSize: number;
  averageEffectiveN: number;
  highCorrelationPairs: CorrelationPair[];
  alerts: ConcentrationAlert[];
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function computePearson(x: number[], y: number[]): number {
  const n = x.length;
  if (n <= 1) return 0;

  const meanX = mean(x);
  const meanY = mean(y);

  let num = 0;
  let denX = 0;
  let denY = 0;

  for (let i = 0; i < n; i++) {
    const diffX = x[i] - meanX;
    const diffY = y[i] - meanY;
    num += diffX * diffY;
    denX += diffX * diffX;
    denY += diffY * diffY;
  }

  const den = Math.sqrt(denX * denY);
  if (den === 0) return 0; // No variance in at least one dataset

  return num / den;
}

/**
 * Computes strategy correlation diagnostics.
 * Designed to run asynchronously inside the background runner or a separate worker.
 */
export async function computeRollingCorrelations(windowSize = 100): Promise<CorrelationReport> {
  const reportTime = new Date();
  
  // 1. Fetch recent signals
  const signals = await prisma.explainableSignal.findMany({
    where: {
      strategySignals: { not: Prisma.DbNull },
    },
    orderBy: { timestamp: "desc" },
    take: windowSize,
  });

  if (signals.length === 0) {
    return {
      timestamp: reportTime,
      rollingWindowSize: 0,
      averageEffectiveN: 0,
      highCorrelationPairs: [],
      alerts: [],
    };
  }

  // 2. Calculate average effectiveN over the window
  const effectiveNs = signals
    .map((s) => s.effectiveN)
    .filter((n): n is number => n !== null);
  const avgEffectiveN = effectiveNs.length > 0 ? mean(effectiveNs) : 0;

  // 3. Extract time series signals for each active strategy
  const activeStrategies = StrategyRegistry.all();
  const seriesMap = new Map<string, number[]>();

  // Initialize arrays with 0 (HOLD)
  for (const strat of activeStrategies) {
    seriesMap.set(strat.id, new Array(signals.length).fill(0));
  }

  // Populate signals (signals are ordered desc, so index 0 is most recent)
  signals.forEach((sig, timeIdx) => {
    const rawSignals = typeof sig.strategySignals === "string"
      ? JSON.parse(sig.strategySignals)
      : sig.strategySignals;

    if (Array.isArray(rawSignals)) {
      rawSignals.forEach((vote: any) => {
        const stratId = vote.strategyId;
        if (seriesMap.has(stratId)) {
          const val = vote.signal === "BUY" ? 1 : vote.signal === "SELL" ? -1 : 0;
          seriesMap.get(stratId)![timeIdx] = val;
        }
      });
    }
  });

  // 4. Calculate pairwise correlations between all strategy pairs
  const highCorrelationPairs: CorrelationPair[] = [];
  const stratIds = Array.from(seriesMap.keys());

  for (let i = 0; i < stratIds.length; i++) {
    for (let j = i + 1; j < stratIds.length; j++) {
      const idA = stratIds[i];
      const idB = stratIds[j];
      const nameA = StrategyRegistry.get(idA)?.name ?? idA;
      const nameB = StrategyRegistry.get(idB)?.name ?? idB;

      const x = seriesMap.get(idA)!;
      const y = seriesMap.get(idB)!;

      const r = computePearson(x, y);

      // We only flag pairs with high correlation (r > 0.7 or r < -0.7)
      if (Math.abs(r) > 0.7) {
        highCorrelationPairs.push({
          strategyA: nameA,
          strategyB: nameB,
          correlation: Math.round(r * 100) / 100,
        });
      }
    }
  }

  // Sort pairs by absolute correlation descending
  highCorrelationPairs.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));

  // 5. Build alerts if effectiveN drops or if high correlations are present
  const alerts: ConcentrationAlert[] = [];
  
  if (avgEffectiveN > 0 && avgEffectiveN < 1.3) {
    alerts.push({
      timestamp: reportTime,
      avgEffectiveN,
      message: `CRITICAL: Average effectiveN is extremely low (${avgEffectiveN.toFixed(2)} < 1.3). High concentration of signals on a single factor.`,
      severity: "critical",
    });
  } else if (avgEffectiveN > 0 && avgEffectiveN < 2.0) {
    alerts.push({
      timestamp: reportTime,
      avgEffectiveN,
      message: `WARNING: Average effectiveN is low (${avgEffectiveN.toFixed(2)} < 2.0). Monitor for potential signal decay or trend double-counting.`,
      severity: "warning",
    });
  }

  if (highCorrelationPairs.length > 5) {
    alerts.push({
      timestamp: reportTime,
      avgEffectiveN,
      message: `INFO: Detected ${highCorrelationPairs.length} strategy pairs with correlation > 0.7. Consider culling redundant indicators.`,
      severity: "info",
    });
  }

  // 6. Log warnings asynchronously if needed (does not block hot path)
  alerts.forEach((alert) => {
    if (alert.severity === "critical") {
      console.warn(`[CORRELATION-ALERT-CRITICAL] ${alert.message}`);
    } else if (alert.severity === "warning") {
      console.info(`[CORRELATION-ALERT-WARN] ${alert.message}`);
    }
  });

  return {
    timestamp: reportTime,
    rollingWindowSize: signals.length,
    averageEffectiveN: Math.round(avgEffectiveN * 100) / 100,
    highCorrelationPairs,
    alerts,
  };
}
