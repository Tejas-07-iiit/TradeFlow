import type { MarketRegime } from "../types";

export interface DateRange {
  start: Date;
  end: Date;
}

export interface WalkForwardSplit {
  splitIndex: number;
  inSampleRange: DateRange;
  outOfSampleRange: DateRange;
  primaryRegime: MarketRegime | "mixed";
}

export interface BacktestMetadata {
  backtestId: string;
  strategyId: string;
  parameters: Record<string, any>;
  overallSharpe: number;
  overallWinRate: number;
  maxDrawdown: number;
  splitsCompleted: number;
}

export interface ValidationMetrics {
  inSampleSharpe: number;
  outOfSampleSharpe: number;
  inSampleWinRate: number;
  outOfSampleWinRate: number;
  decayRate: number; // in-sample vs out-of-sample performance decay (e.g. outOfSampleSharpe / inSampleSharpe)
}

export interface StrategyEvaluator {
  evaluateStrategy: (
    strategyId: string,
    split: WalkForwardSplit,
    parameters: Record<string, any>
  ) => Promise<ValidationMetrics>;
}

/**
 * Generate walk-forward validation splits given a total date range,
 * train (in-sample) window size in days, and test (out-of-sample) window size in days.
 */
export function generateWalkForwardSplits(
  range: DateRange,
  trainDays = 180,
  testDays = 60
): WalkForwardSplit[] {
  const splits: WalkForwardSplit[] = [];
  const startMs = range.start.getTime();
  const endMs = range.end.getTime();

  const oneDayMs = 24 * 60 * 60 * 1000;
  const trainStepMs = trainDays * oneDayMs;
  const testStepMs = testDays * oneDayMs;

  let currentTrainStart = startMs;
  let index = 0;

  while (true) {
    const currentTrainEnd = currentTrainStart + trainStepMs;
    const currentTestEnd = currentTrainEnd + testStepMs;

    if (currentTestEnd > endMs) {
      break; // Split goes beyond the available data range
    }

    splits.push({
      splitIndex: index,
      inSampleRange: {
        start: new Date(currentTrainStart),
        end: new Date(currentTrainEnd),
      },
      outOfSampleRange: {
        start: new Date(currentTrainEnd),
        end: new Date(currentTestEnd),
      },
      primaryRegime: "mixed",
    });

    // Walk forward by the test window size (anchored walk-forward)
    currentTrainStart += testStepMs;
    index++;
  }

  return splits;
}

/**
 * Collects parameter sweep metadata. Surfaces the out-of-sample decay profile
 * to detect overfitting prior to production release.
 */
export function analyzeParameterDecay(
  inSampleResults: Record<string, number>,
  outOfSampleResults: Record<string, number>
): { optimalParam: string; decayPercent: number; isOverfit: boolean } {
  let optimalParam = "";
  let bestInSampleScore = -Infinity;

  for (const [param, score] of Object.entries(inSampleResults)) {
    if (score > bestInSampleScore) {
      bestInSampleScore = score;
      optimalParam = param;
    }
  }

  if (!optimalParam) {
    return { optimalParam: "", decayPercent: 0, isOverfit: false };
  }

  const oosScore = outOfSampleResults[optimalParam] ?? 0;
  
  // Calculate performance decay percent: how much did we lose out-of-sample?
  const decay = bestInSampleScore > 0 
    ? ((bestInSampleScore - oosScore) / bestInSampleScore) * 100 
    : 0;

  // Overfitting rule of thumb: OOS score drops by more than 40%
  const isOverfit = decay > 40;

  return {
    optimalParam,
    decayPercent: Math.round(decay * 100) / 100,
    isOverfit,
  };
}
