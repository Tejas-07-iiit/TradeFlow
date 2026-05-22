import type { StrategyContext, StrategyDefinition, StrategyOutput } from "@/strategy-core/types";
import type { Candle } from "@/types/market";

/**
 * Rally-Base-Drop / Drop-Base-Rally supply & demand zones (LuxAlgo style).
 *
 * Identifies pivot zones where price consolidated ("Base") between two
 * directional impulses, then trades a return into one of those zones. The
 * zone is treated as institutional liquidity: longs at fresh demand zones,
 * shorts at fresh supply zones, both filtered by the macro EMA.
 */
interface Zone {
  type: "demand" | "supply";
  top: number;
  bottom: number;
  formedAt: number;
}

function detectZones(candles: Candle[]): Zone[] {
  // Scan for { directional move → 1-3 base bars → opposing directional move }.
  // A "directional" bar is body > 60% of the high-low range.
  const zones: Zone[] = [];
  const bodyPct = (c: Candle) =>
    (c.high === c.low ? 0 : Math.abs(c.close - c.open) / (c.high - c.low));
  for (let i = 4; i < candles.length - 1; i += 1) {
    const a = candles[i - 4];
    const b = candles[i - 3];
    const baseA = candles[i - 2];
    const baseB = candles[i - 1];
    const aDir = a.close > a.open;
    const bDir = b.close > b.open;
    if (aDir === bDir) continue;
    if (bodyPct(a) < 0.6 || bodyPct(b) < 0.6) continue;
    if (bodyPct(baseA) > 0.6 || bodyPct(baseB) > 0.6) continue;
    const top = Math.max(baseA.high, baseB.high);
    const bottom = Math.min(baseA.low, baseB.low);
    if (!aDir && bDir) {
      // Drop → Base → Rally → demand zone
      zones.push({ type: "demand", top, bottom, formedAt: baseB.time });
    } else if (aDir && !bDir) {
      // Rally → Base → Drop → supply zone
      zones.push({ type: "supply", top, bottom, formedAt: baseB.time });
    }
  }
  // Keep only the latest 12 zones — older zones lose institutional relevance.
  return zones.slice(-12);
}

function evaluate(ctx: StrategyContext): StrategyOutput {
  const { ema200, atr14 } = ctx.indicators;
  const reasoning: string[] = [];

  if (ctx.candles.length < 30) {
    return shell({
      signal: "HOLD",
      confidence: 25,
      reasoning: ["Need at least 30 bars to detect SND zones."],
      trendScore: 0,
    });
  }

  const zones = detectZones(ctx.candles);
  if (zones.length === 0) {
    return shell({
      signal: "HOLD",
      confidence: 30,
      reasoning: ["No Rally-Base-Drop / Drop-Base-Rally structures detected in window."],
      trendScore: 0,
    });
  }

  const price = ctx.price;
  const atr = atr14 ?? price * 0.005;
  let signal: StrategyOutput["signal"] = "HOLD";
  let confidence = 35;
  let trendScore = 0;

  // Pick the most recent zone the price is touching.
  let active: Zone | null = null;
  for (let i = zones.length - 1; i >= 0; i -= 1) {
    const z = zones[i];
    const padded = atr * 0.5;
    if (price >= z.bottom - padded && price <= z.top + padded) {
      active = z;
      break;
    }
  }

  if (!active) {
    reasoning.push(`Price ${price.toFixed(2)} not currently inside any of ${zones.length} active SND zone(s).`);
    return shell({ signal, confidence, reasoning, trendScore });
  }

  const macroAgrees =
    ema200 == null ||
    (active.type === "demand" && price > ema200) ||
    (active.type === "supply" && price < ema200);

  if (active.type === "demand" && macroAgrees) {
    signal = "BUY";
    confidence = 70;
    trendScore = 55;
    reasoning.push(
      `Price ${price.toFixed(2)} re-tested fresh demand zone [${active.bottom.toFixed(2)} – ${active.top.toFixed(2)}].`,
    );
  } else if (active.type === "supply" && macroAgrees) {
    signal = "SELL";
    confidence = 70;
    trendScore = -55;
    reasoning.push(
      `Price ${price.toFixed(2)} re-tested fresh supply zone [${active.bottom.toFixed(2)} – ${active.top.toFixed(2)}].`,
    );
  } else {
    reasoning.push(
      `Zone touched but EMA200 macro disagrees — front-run risk too high.`,
    );
  }

  return shell({
    signal,
    confidence,
    reasoning,
    trendScore,
    suggestedEntry: price,
    suggestedStopLoss:
      active.type === "demand" ? active.bottom - atr * 0.5 : active.top + atr * 0.5,
    suggestedTakeProfit:
      active.type === "demand" ? price + (active.top - active.bottom) * 3 : price - (active.top - active.bottom) * 3,
  });
}

function shell(args: {
  signal: StrategyOutput["signal"];
  confidence: number;
  reasoning: string[];
  trendScore: number;
  suggestedEntry?: number;
  suggestedStopLoss?: number;
  suggestedTakeProfit?: number;
}): StrategyOutput {
  return {
    strategyId: "rally-base-drop",
    strategyName: "Rally-Base-Drop SND Pivots",
    category: "market-structure",
    signal: args.signal,
    confidence: Math.round(Math.min(90, Math.max(0, args.confidence))),
    timeframe: "swing",
    regimeFit: ["Sideways", "Reversal", "Trending Up", "Trending Down"],
    riskLevel: "Medium",
    reasoning: args.reasoning,
    indicatorsUsed: ["Pivot Points", "Body-ratio analysis", "EMA200"],
    entryConditions: [
      "Price returns into a fresh demand zone (Drop-Base-Rally) — long",
      "Price returns into a fresh supply zone (Rally-Base-Drop) — short",
    ],
    exitConditions: [
      "Price reaches the opposing SND zone",
      "Significant break of the pivot structure",
    ],
    stopLossLogic: "Just outside the zone boundary (≈0.5× ATR padding).",
    takeProfitLogic: "Target next major liquidity pool or 3× zone height.",
    volatilityScore: 50,
    momentumScore: args.trendScore * 0.5,
    trendScore: args.trendScore,
    suggestedEntry: args.suggestedEntry,
    suggestedStopLoss: args.suggestedStopLoss,
    suggestedTakeProfit: args.suggestedTakeProfit,
  };
}

export const RallyBaseDrop: StrategyDefinition = {
  id: "rally-base-drop",
  name: "Rally-Base-Drop SND Pivots",
  category: "market-structure",
  description:
    "LuxAlgo-style supply & demand zone detection from rally/drop bookended consolidation bases — fades returns to institutional liquidity zones.",
  timeframes: ["swing", "position"],
  preferredRegimes: ["Sideways", "Reversal", "Trending Up", "Trending Down"],
  minCandles: 30,
  evaluate,
  enabled: true,
};
