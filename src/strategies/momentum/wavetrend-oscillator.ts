import { lastValue, waveTrend } from "@/lib/indicators/calculations";
import type { StrategyContext, StrategyDefinition, StrategyOutput } from "@/strategy-core/types";

/**
 * WaveTrend Oscillator (LazyBear) — WT1/WT2 cross in the overbought /
 * oversold extremes. Signals only when the cross fires *inside* the OB/OS
 * band; mid-range crosses are ignored because they have no edge.
 *
 * Uses ±53 as the canonical OB/OS thresholds (LazyBear's "Overbought Lv2 /
 * Oversold Lv2" lines) rather than the spec's ±60 to surface a few more
 * actionable extremes; ±60 is still flagged as "extreme" with a confidence
 * boost.
 */
const OB = 53;
const OS = -53;
const EXTREME = 60;

function evaluate(ctx: StrategyContext): StrategyOutput {
  const reasoning: string[] = [];
  if (ctx.candles.length < 35) {
    return shell({
      signal: "HOLD",
      confidence: 25,
      reasoning: ["Need ≥35 bars for stable WaveTrend."],
      momentumScore: 0,
    });
  }

  const series = waveTrend(ctx.candles, 10, 21, 4);
  const current = lastValue(series);
  const prev = series.at(-2) ?? null;
  if (!current || !prev) {
    return shell({
      signal: "HOLD",
      confidence: 25,
      reasoning: ["WaveTrend not yet stable."],
      momentumScore: 0,
    });
  }

  const crossUp = prev.wt1 <= prev.wt2 && current.wt1 > current.wt2;
  const crossDown = prev.wt1 >= prev.wt2 && current.wt1 < current.wt2;
  let signal: StrategyOutput["signal"] = "HOLD";
  let confidence = 35;
  let momentumScore = 0;

  if (crossUp && current.wt2 <= OS) {
    const extreme = current.wt2 <= -EXTREME;
    signal = "BUY";
    confidence = extreme ? 78 : 65;
    momentumScore = extreme ? 75 : 60;
    reasoning.push(
      `WT1 ${current.wt1.toFixed(1)} crossed up through WT2 ${current.wt2.toFixed(1)} in oversold zone (${extreme ? "extreme" : "standard"}).`,
    );
  } else if (crossDown && current.wt2 >= OB) {
    const extreme = current.wt2 >= EXTREME;
    signal = "SELL";
    confidence = extreme ? 78 : 65;
    momentumScore = extreme ? -75 : -60;
    reasoning.push(
      `WT1 ${current.wt1.toFixed(1)} crossed down through WT2 ${current.wt2.toFixed(1)} in overbought zone (${extreme ? "extreme" : "standard"}).`,
    );
  } else {
    reasoning.push(
      `No actionable WT cross at extreme — WT1=${current.wt1.toFixed(1)} WT2=${current.wt2.toFixed(1)}.`,
    );
  }

  return shell({ signal, confidence, reasoning, momentumScore });
}

function shell(args: {
  signal: StrategyOutput["signal"];
  confidence: number;
  reasoning: string[];
  momentumScore: number;
}): StrategyOutput {
  return {
    strategyId: "wavetrend-oscillator",
    strategyName: "WaveTrend Oscillator (LazyBear)",
    category: "momentum",
    signal: args.signal,
    confidence: Math.round(Math.min(88, Math.max(0, args.confidence))),
    timeframe: "intraday",
    regimeFit: ["Reversal", "Sideways", "Low Volatility", "High Volatility"],
    riskLevel: "Medium",
    reasoning: args.reasoning,
    indicatorsUsed: ["WaveTrend WT1", "WaveTrend WT2"],
    entryConditions: [
      "WT1 crosses above WT2 in oversold zone (≤ -53)",
      "WT1 crosses below WT2 in overbought zone (≥ +53)",
    ],
    exitConditions: ["Opposite WT cross", "WT1 reaches zero line"],
    stopLossLogic: "Swing high/low or 1.2× ATR.",
    takeProfitLogic: "Opposite OB/OS extreme.",
    volatilityScore: 45,
    momentumScore: args.momentumScore,
    trendScore: -args.momentumScore * 0.4,
  };
}

export const WaveTrendOscillator: StrategyDefinition = {
  id: "wavetrend-oscillator",
  name: "WaveTrend Oscillator",
  category: "momentum",
  description:
    "LazyBear WaveTrend — fires only on WT1/WT2 crosses inside the overbought/oversold bands, surfacing high-conviction exhaustion reversals.",
  timeframes: ["intraday", "short-term"],
  preferredRegimes: ["Reversal", "Sideways", "Low Volatility", "High Volatility"],
  minCandles: 35,
  evaluate,
  enabled: true,
};
