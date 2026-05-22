import { lastNumber, sma } from "@/lib/indicators/calculations";
import type { StrategyContext, StrategyDefinition, StrategyOutput } from "@/strategy-core/types";

/**
 * Hash Ribbons — BTC miner-capitulation indicator.
 *
 * The original signal needs a hash-rate feed (network hashes/sec). TradeFlow
 * does not currently subscribe to a Bitcoin hash-rate provider, so this
 * strategy *cannot* fire its proper buy signal — it would be dishonest to
 * pretend otherwise.
 *
 * Behaviour:
 *   - For non-BTC symbols → permanent HOLD with explicit reasoning.
 *   - For BTC, if `ctx` carries a hashRate30/60 sentiment hint (future
 *     extension), use the proper Hash Ribbons logic.
 *   - Otherwise emit a price-momentum-only proxy at low confidence, clearly
 *     labelled as "proxy" in the reasoning so the LLM / UI can rank it
 *     accordingly. This is the honest degradation path.
 */
interface HashRateHint {
  sma30: number;
  sma60: number;
}

function isBitcoin(symbol: string): boolean {
  const s = symbol.toUpperCase();
  return s.startsWith("BTC") || s.endsWith("BTC") || s.includes("BTCUSDT");
}

function evaluate(ctx: StrategyContext): StrategyOutput {
  const reasoning: string[] = [];
  if (!isBitcoin(ctx.symbol)) {
    return shell({
      signal: "HOLD",
      confidence: 0,
      reasoning: [
        `Hash Ribbons is BTC-only; symbol ${ctx.symbol} does not apply.`,
      ],
      trendScore: 0,
    });
  }

  // Future: read hash-rate SMAs from a sentiment extension on StrategyContext.
  const hashHint = (ctx.sentiment as unknown as { hashRibbons?: HashRateHint } | undefined)
    ?.hashRibbons;
  const closes = ctx.candles.map((c) => c.close);
  const priceSma10 = lastNumber(sma(closes, 10));
  const priceSma20 = lastNumber(sma(closes, 20));

  if (hashHint) {
    const { sma30, sma60 } = hashHint;
    const recovering = sma30 > sma60;
    const priceMomentumBull =
      priceSma10 != null && priceSma20 != null && priceSma10 > priceSma20;
    if (recovering && priceMomentumBull) {
      return shell({
        signal: "BUY",
        confidence: 82,
        reasoning: [
          `Hash-Rate 30 SMA (${sma30.toFixed(2)}) > 60 SMA (${sma60.toFixed(2)}) — miner recovery.`,
          `Price momentum confirms (SMA10 > SMA20).`,
        ],
        trendScore: 75,
      });
    }
    return shell({
      signal: "HOLD",
      confidence: 35,
      reasoning: [
        `Hash-Rate 30 SMA ${sma30 > sma60 ? "above" : "below"} 60 SMA — no fresh recovery cross.`,
      ],
      trendScore: 0,
    });
  }

  // Proxy mode — clearly labelled so consumers know this is not the real signal.
  if (priceSma10 != null && priceSma20 != null && priceSma10 > priceSma20) {
    return shell({
      signal: "HOLD",
      confidence: 30,
      reasoning: [
        "Hash-rate feed not wired — running as price-only proxy.",
        `Price SMA10 > SMA20 — bullish lean but cannot confirm miner capitulation recovery.`,
      ],
      trendScore: 20,
    });
  }

  return shell({
    signal: "HOLD",
    confidence: 0,
    reasoning: [
      "Hash-rate feed not wired and no bullish price proxy — Hash Ribbons abstains.",
    ],
    trendScore: 0,
  });
}

function shell(args: {
  signal: StrategyOutput["signal"];
  confidence: number;
  reasoning: string[];
  trendScore: number;
}): StrategyOutput {
  return {
    strategyId: "hash-ribbons",
    strategyName: "Hash Ribbons (BTC)",
    category: "sentiment",
    signal: args.signal,
    confidence: Math.round(Math.min(90, Math.max(0, args.confidence))),
    timeframe: "monthly",
    regimeFit: ["Reversal", "Low Volatility"],
    riskLevel: "Low",
    reasoning: args.reasoning,
    indicatorsUsed: ["Hash Rate 30 SMA (requires external feed)", "Hash Rate 60 SMA", "Price SMA10/20"],
    entryConditions: [
      "Hash Rate 30 SMA crosses above 60 SMA (miner recovery)",
      "Price momentum confirms (SMA10 > SMA20)",
    ],
    exitConditions: ["Macro trend reversal", "Long-term target fulfilled"],
    stopLossLogic: "Below local bottom or 200-day MA.",
    takeProfitLogic: "Multi-month / multi-year hold; partial at parabolic extension.",
    volatilityScore: 25,
    momentumScore: args.trendScore * 0.4,
    trendScore: args.trendScore,
  };
}

export const HashRibbons: StrategyDefinition = {
  id: "hash-ribbons",
  name: "Hash Ribbons (BTC)",
  category: "sentiment",
  description:
    "Bitcoin miner-capitulation macro signal. Currently runs in proxy mode because TradeFlow does not yet subscribe to a hash-rate feed — wire one into StrategyContext.sentiment.hashRibbons to unlock the full signal.",
  timeframes: ["monthly", "position"],
  preferredRegimes: ["Reversal", "Low Volatility"],
  minCandles: 25,
  evaluate,
  enabled: true,
};
