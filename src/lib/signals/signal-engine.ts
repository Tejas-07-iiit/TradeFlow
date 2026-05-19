import type { AIDecision, DecisionSignal, MarketCondition, SignalStatus, SignalType } from "@/types/ai-decision";
import type { Candle } from "@/types/market";

import {
  adx,
  atr,
  bollingerBands,
  ema,
  lastNumber,
  lastValue,
  macd,
  rsi,
  vwap,
  vwapSlope,
  zScore,
} from "@/lib/indicators/calculations";

export type IndicatorSnapshot = {
  ema50: number | null;
  ema200: number | null;
  rsi14: number | null;
  atr14: number | null;
  adx14: number | null;
  atrPct: number | null;
  bb: { upper: number; middle: number; lower: number } | null;
  macd: { macd: number; signalLine: number; histogram: number } | null;
  /** Latest 20-period z-score of close vs its rolling mean. */
  zScore20: number | null;
  /** Latest anchored VWAP value. */
  vwap: number | null;
  /** Sign of the VWAP slope over the last ~10 bars. +1 rising / -1 falling / 0 flat. */
  vwapSlope: -1 | 0 | 1;
  regime: MarketCondition;
};

export function calculateIndicators(candles: Candle[]): IndicatorSnapshot {
  if (candles.length < 20) {
    return {
      ema50: null,
      ema200: null,
      rsi14: null,
      atr14: null,
      adx14: null,
      atrPct: null,
      bb: null,
      macd: null,
      zScore20: null,
      vwap: null,
      vwapSlope: 0,
      regime: "Choppy",
    };
  }
  const closes = candles.map((candle) => candle.close);
  const ema50 = lastNumber(ema(closes, 50));
  const ema200 = lastNumber(ema(closes, 200));
  const rsi14 = lastNumber(rsi(closes, 14));
  const atr14 = lastNumber(atr(candles, 14));
  const adx14 = lastNumber(adx(candles, 14));
  const lastClose = closes.at(-1) ?? null;
  const atrPct = atr14 && lastClose ? (atr14 / lastClose) * 100 : null;

  const bb = lastValue(bollingerBands(closes, 20, 2));
  const macdVal = lastValue(macd(closes, 12, 26, 9));

  const zScore20 = lastNumber(zScore(closes, 20));
  const vwapSeries = vwap(candles);
  const vwapVal = lastNumber(vwapSeries);
  const slope = vwapSlope(vwapSeries, 10);

  const regime = detectRegime({ ema50, ema200, rsi14, atrPct, adx14 });

  return {
    ema50,
    ema200,
    rsi14,
    atr14,
    adx14,
    atrPct,
    bb,
    macd: macdVal,
    zScore20,
    vwap: vwapVal,
    vwapSlope: slope,
    regime,
  };
}

export function generateDecision(
  symbol: string,
  allCandles: Record<string, Candle[]>,
  activeInterval: string,
): AIDecision {
  const candles = allCandles[`${symbol}:${activeInterval}`] ?? [];
  const indicators = calculateIndicators(candles);
  const lastCandle = candles.at(-1);

  // MTF Confirmation (Check 15m for trend if on 1m/5m)
  const htfInterval = activeInterval === "1m" ? "15m" : activeInterval === "5m" ? "1H" : null;
  const htfCandles = htfInterval ? allCandles[`${symbol}:${htfInterval}`] ?? [] : [];
  const htfTrend = htfCandles.length > 20 ? calculateHTFTrend(htfCandles) : "neutral";

  if (!lastCandle) {
    return holdDecision(symbol, indicators, "Market in low-liquidity state or awaiting data.");
  }

  // Intraday Setup Logic
  const setup = detectSetup(candles, indicators, htfTrend);
  const signal = setup.signal;
  const type = setup.type;

  if (signal === "HOLD") {
    let reason: string;
    if (indicators.regime === "High Volatility") {
      reason = `Regime is ${indicators.regime} — entries blocked until volatility cools.`;
    } else if (indicators.regime === "Choppy") {
      reason = "Regime is Choppy — only mean-reversion setups allowed and none aligned.";
    } else if (htfTrend !== "neutral") {
      reason = `HTF Bias is ${htfTrend}, but local timing is not yet aligned.`;
    } else {
      reason = "Waiting for momentum alignment.";
    }
    return holdDecision(symbol, indicators, reason);
  }

  const confidence = calculateIntradayConfidence(indicators, setup, htfTrend);
  
  // Realistic Intraday SL/TP (Tight ATR-based)
  const lastClose = lastCandle.close;
  const atrVal = indicators.atr14 ?? (lastClose * 0.005);
  
  const slMult = 1.8; 
  const tpMult = 4.0; // ~1:2.2 RR

  let stopLoss: number | undefined;
  let takeProfit: number | undefined;

  if (signal === "BUY") {
    stopLoss = lastClose - (atrVal * slMult);
    takeProfit = lastClose + (atrVal * tpMult);
  } else {
    stopLoss = lastClose + (atrVal * slMult);
    takeProfit = lastClose - (atrVal * tpMult);
  }

  const rrRatio = (Math.abs(takeProfit - lastClose) / Math.abs(lastClose - stopLoss));
  const setupQuality = confidence > 80 ? "A+" : confidence > 70 ? "A" : confidence > 60 ? "B" : "C";
  
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString(); 

  return {
    symbol,
    signal,
    type,
    status: "ACTIVE",
    confidence,
    risk: indicators.atrPct && indicators.atrPct > 2 ? "High" : "Medium",
    marketCondition: indicators.regime,
    entryPrice: lastClose,
    stopLoss,
    takeProfit,
    rrRatio,
    setupQuality,
    expectedHoldTime: "30-90 mins",
    reasons: buildIntradayReasons(indicators, setup, activeInterval, htfTrend),
    warnings: buildIntradayWarnings(indicators),
    verdict: buildIntradayVerdict(setup, indicators, htfTrend),
    generatedAt: now.toISOString(),
    expiresAt,
  };
}

function calculateHTFTrend(candles: Candle[]): "bullish" | "bearish" | "neutral" {
  const closes = candles.map(c => c.close);
  const ema50 = lastNumber(ema(closes, 50));
  const ema200 = lastNumber(ema(closes, 200));
  if (!ema50 || !ema200) return "neutral";
  if (ema50 > ema200) return "bullish";
  if (ema50 < ema200) return "bearish";
  return "neutral";
}

function detectRegime({
  ema50,
  ema200,
  atrPct,
  adx14,
}: Partial<IndicatorSnapshot>): MarketCondition {
  if ((atrPct ?? 0) > 3) return "High Volatility";
  if ((adx14 ?? 0) < 18) return "Choppy";
  if (ema50 != null && ema200 != null) {
    const spread = Math.abs(ema50 - ema200) / ema200;
    if (spread < 0.002) return "Compression";
    return "Trending";
  }
  return "Sideways";
}

/**
 * Setups are partitioned by regime so trend-following and mean-reversion
 * strategies never collide on the same bar:
 *
 *   Trending  → BREAKOUT, PULLBACK, MOMENTUM, SCALP, BREAKDOWN allowed.
 *               Mean-reversion blocked (trying to fade a real trend bleeds
 *               equity).
 *   Sideways  → both trend and mean-reversion allowed (regime classifier
 *   /Compression  isn't sure either way; let the indicator-level filters
 *                 decide).
 *   Choppy    → ONLY mean-reversion allowed. Trend setups in choppy regimes
 *               are the dominant source of whipsaw losses.
 *   HighVol   → trades blocked entirely; the warning surfaces this to the
 *               operator (we still emit HOLD with a regime-specific reason).
 *
 * Mean-reversion uses |z-score| > 2 (95th-percentile stretch) AND Bollinger
 * confirmation AND RSI confirmation — three filters that all have to align,
 * to keep this rule from firing on every Bollinger touch.
 *
 * VWAP is used as a *bias* filter on long-side trend entries: requiring price
 * > rising VWAP filters out longs taken into a falling-VWAP tape.
 */
function detectSetup(
  candles: Candle[],
  indicators: IndicatorSnapshot,
  htfTrend: string,
): { signal: DecisionSignal; type: SignalType } {
  const last = candles.at(-1)!;
  const regime = indicators.regime;
  const trendAllowed = regime === "Trending" || regime === "Sideways" || regime === "Compression";
  const meanRevAllowed = regime === "Choppy" || regime === "Sideways" || regime === "Compression";

  // High-volatility regimes block all entries — let risk cool off.
  if (regime === "High Volatility") {
    return { signal: "HOLD", type: "NONE" };
  }

  // VWAP bias: price relative to a rising/falling VWAP, used to confirm
  // directional setups. Null/flat VWAP is permissive — don't block on
  // missing data, only on contradiction.
  const longVwapOk =
    indicators.vwap == null || indicators.vwapSlope >= 0
      ? indicators.vwap == null || last.close >= indicators.vwap
      : false;
  const shortVwapOk =
    indicators.vwap == null || indicators.vwapSlope <= 0
      ? indicators.vwap == null || last.close <= indicators.vwap
      : false;

  if (trendAllowed) {
    // 1. Breakout Long (HTF + VWAP aligned).
    const recentHigh = Math.max(...candles.slice(-10, -1).map((c) => c.high));
    if (
      last.close > recentHigh &&
      (indicators.rsi14 ?? 50) > 55 &&
      htfTrend !== "bearish" &&
      longVwapOk
    ) {
      return { signal: "BUY", type: "BREAKOUT LONG" };
    }

    // 2. Breakdown Short.
    const recentLow = Math.min(...candles.slice(-10, -1).map((c) => c.low));
    if (
      last.close < recentLow &&
      (indicators.rsi14 ?? 50) < 45 &&
      htfTrend !== "bullish" &&
      shortVwapOk
    ) {
      return { signal: "SELL", type: "BREAKDOWN SHORT" };
    }

    // 3. Pullback Long with EMA50 > EMA200 stack.
    const trendingUp =
      indicators.ema50 && indicators.ema200 && indicators.ema50 > indicators.ema200;
    if (
      trendingUp &&
      (indicators.rsi14 ?? 50) > 45 &&
      (indicators.rsi14 ?? 50) < 65 &&
      htfTrend === "bullish" &&
      longVwapOk
    ) {
      return { signal: "BUY", type: "PULLBACK LONG" };
    }

    // 4. Momentum Scalp (MACD histogram flip while line still negative).
    if (
      indicators.macd &&
      indicators.macd.histogram > 0 &&
      indicators.macd.macd < 0 &&
      htfTrend !== "bearish" &&
      longVwapOk
    ) {
      return { signal: "BUY", type: "MOMENTUM LONG" };
    }
    if (
      indicators.macd &&
      indicators.macd.histogram < 0 &&
      indicators.macd.macd > 0 &&
      htfTrend !== "bullish" &&
      shortVwapOk
    ) {
      return { signal: "SELL", type: "MOMENTUM SHORT" };
    }

    // 5. ADX-confirmed long scalp.
    if (
      (indicators.adx14 ?? 0) > 25 &&
      (indicators.rsi14 ?? 50) > 60 &&
      htfTrend !== "bearish" &&
      longVwapOk
    ) {
      return { signal: "BUY", type: "SCALP LONG" };
    }
  }

  if (meanRevAllowed && indicators.bb && indicators.zScore20 != null) {
    // Triple-filter mean reversion: BB touch + RSI extreme + z-score > 2.
    // All three have to agree, which is what keeps this rule from firing
    // on every minor band tag during a trend.
    if (
      last.close <= indicators.bb.lower &&
      (indicators.rsi14 ?? 50) < 35 &&
      indicators.zScore20 <= -2
    ) {
      return { signal: "BUY", type: "REVERSAL LONG" };
    }
    if (
      last.close >= indicators.bb.upper &&
      (indicators.rsi14 ?? 50) > 65 &&
      indicators.zScore20 >= 2
    ) {
      return { signal: "SELL", type: "RANGE TRADE" };
    }
  }

  return { signal: "HOLD", type: "NONE" };
}

function calculateIntradayConfidence(indicators: IndicatorSnapshot, setup: { type: SignalType }, htfTrend: string) {
  let score = 50;
  if (htfTrend === (setup.type.includes("LONG") ? "bullish" : "bearish")) score += 20;
  if ((indicators.adx14 ?? 0) > 25) score += 10;
  return Math.min(95, score);
}

function buildIntradayReasons(
  indicators: IndicatorSnapshot,
  setup: { type: SignalType },
  timeframe: string,
  htfTrend: string,
) {
  const reasons = [];
  reasons.push(`${setup.type}: setup identified on ${timeframe}.`);
  reasons.push(`Regime: ${indicators.regime} — strategy filter passed.`);
  if (htfTrend !== "neutral") {
    reasons.push(
      `HTF Bias: Higher timeframe is ${htfTrend}, providing structural tailwinds.`,
    );
  }
  if (indicators.adx14 && indicators.adx14 > 20) {
    reasons.push(
      `Trend Strength: ADX at ${indicators.adx14.toFixed(1)} confirms directional intent.`,
    );
  }
  if (indicators.zScore20 != null && Math.abs(indicators.zScore20) >= 1.5) {
    reasons.push(
      `Mean deviation: z-score ${indicators.zScore20.toFixed(2)} — price ${
        indicators.zScore20 > 0 ? "stretched above" : "stretched below"
      } the 20-bar mean.`,
    );
  }
  if (indicators.vwap != null && indicators.vwapSlope !== 0) {
    reasons.push(
      `VWAP ${indicators.vwapSlope > 0 ? "rising" : "falling"} at ${indicators.vwap.toFixed(2)}.`,
    );
  }
  return reasons;
}

function buildIntradayWarnings(indicators: IndicatorSnapshot) {
  const warnings = [];
  if (indicators.regime === "High Volatility") warnings.push("Elevated volatility; tighten risk.");
  if (indicators.regime === "Choppy") warnings.push("Price action lacks directional clarity.");
  return warnings;
}

function buildIntradayVerdict(setup: { type: SignalType }, indicators: IndicatorSnapshot, htfTrend: string) {
  return `High-probability intraday ${setup.type} aligned with ${htfTrend} bias.`;
}

function holdDecision(symbol: string, indicators: IndicatorSnapshot, reason: string): AIDecision {
  const now = new Date();
  return {
    symbol,
    signal: "HOLD",
    type: "NONE",
    status: "NEW",
    confidence: 45,
    risk: "Low",
    marketCondition: indicators.regime,
    setupQuality: "C",
    expectedHoldTime: "N/A",
    reasons: [reason],
    warnings: [],
    verdict: "No intraday setup currently active.",
    generatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 15 * 60 * 1000).toISOString(),
  };
}

function rsiState(value: number) {
  if (value > 70) return "overbought";
  if (value > 55) return "bullish";
  if (value < 30) return "oversold";
  if (value < 45) return "bearish";
  return "neutral";
}
