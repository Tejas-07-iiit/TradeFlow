import type { AIDecision, DecisionSignal, MarketCondition, SignalStatus, SignalType } from "@/types/ai-decision";
import type { Candle } from "@/types/market";

import { adx, atr, ema, lastNumber, rsi } from "@/lib/indicators/calculations";

export type IndicatorSnapshot = {
  ema50: number | null;
  ema200: number | null;
  rsi14: number | null;
  atr14: number | null;
  adx14: number | null;
  atrPct: number | null;
  regime: MarketCondition;
};

export function calculateIndicators(candles: Candle[]): IndicatorSnapshot {
  if (candles.length < 20) {
    return { ema50: null, ema200: null, rsi14: null, atr14: null, adx14: null, atrPct: null, regime: "Choppy" };
  }
  const closes = candles.map((candle) => candle.close);
  const ema50 = lastNumber(ema(closes, 50));
  const ema200 = lastNumber(ema(closes, 200));
  const rsi14 = lastNumber(rsi(closes, 14));
  const atr14 = lastNumber(atr(candles, 14));
  const adx14 = lastNumber(adx(candles, 14));
  const lastClose = closes.at(-1) ?? null;
  const atrPct = atr14 && lastClose ? (atr14 / lastClose) * 100 : null;
  const regime = detectRegime({ ema50, ema200, rsi14, atrPct, adx14 });

  return { ema50, ema200, rsi14, atr14, adx14, atrPct, regime };
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

  if (!lastCandle || indicators.regime === "Choppy") {
    return holdDecision(symbol, indicators, "Market in choppy/low-liquidity state. No high-conviction setup detected.");
  }

  // Intraday Setup Logic
  const setup = detectSetup(candles, indicators, htfTrend);
  const signal = setup.signal;
  const type = setup.type;

  if (signal === "HOLD") {
    return holdDecision(symbol, indicators, htfTrend !== "neutral" ? `HTF Bias is ${htfTrend}, but local timing is not yet aligned.` : "Waiting for momentum alignment.");
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

function detectSetup(candles: Candle[], indicators: IndicatorSnapshot, htfTrend: string): { signal: DecisionSignal, type: SignalType } {
  const last = candles.at(-1)!;
  
  // 1. Breakout Long (Aligned with HTF)
  const recentHigh = Math.max(...candles.slice(-20, -1).map(c => c.high));
  if (last.close > recentHigh && (indicators.rsi14 ?? 50) > 60 && htfTrend !== "bearish") {
    return { signal: "BUY", type: "BREAKOUT LONG" };
  }

  // 2. Breakdown Short (Aligned with HTF)
  const recentLow = Math.min(...candles.slice(-20, -1).map(c => c.low));
  if (last.close < recentLow && (indicators.rsi14 ?? 50) < 40 && htfTrend !== "bullish") {
    return { signal: "SELL", type: "BREAKDOWN SHORT" };
  }

  // 3. Pullback Long
  const trendingUp = indicators.ema50 && indicators.ema200 && indicators.ema50 > indicators.ema200;
  if (trendingUp && (indicators.rsi14 ?? 50) > 52 && (indicators.rsi14 ?? 50) < 65 && htfTrend === "bullish") {
    return { signal: "BUY", type: "PULLBACK LONG" };
  }

  // 4. Momentum Scalp
  if ((indicators.adx14 ?? 0) > 30 && (indicators.rsi14 ?? 50) > 68 && htfTrend === "bullish") {
    return { signal: "BUY", type: "SCALP LONG" };
  }

  return { signal: "HOLD", type: "NONE" };
}

function calculateIntradayConfidence(indicators: IndicatorSnapshot, setup: { type: SignalType }, htfTrend: string) {
  let score = 50;
  if (htfTrend === (setup.type.includes("LONG") ? "bullish" : "bearish")) score += 20;
  if ((indicators.adx14 ?? 0) > 25) score += 10;
  return Math.min(95, score);
}

function buildIntradayReasons(indicators: IndicatorSnapshot, setup: { type: SignalType }, timeframe: string, htfTrend: string) {
  const reasons = [];
  reasons.push(`${setup.type}: setup identified on ${timeframe}.`);
  if (htfTrend !== "neutral") {
    reasons.push(`HTF Bias: Higher timeframe is ${htfTrend}, providing structural tailwinds.`);
  }
  if (indicators.adx14 && indicators.adx14 > 20) {
    reasons.push(`Trend Strength: ADX at ${indicators.adx14.toFixed(1)} confirms directional intent.`);
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
