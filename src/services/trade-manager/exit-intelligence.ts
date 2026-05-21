import type {
  ManagedPositionContext,
  ManagementIndicators,
} from "@/types/trade-management";

interface ExitAssessment {
  triggerExit: boolean;
  confidence: number;
  reason: string;
}

export function checkEarlyExit(
  position: ManagedPositionContext,
  indicators: ManagementIndicators
): ExitAssessment {
  const isLong = position.side === "LONG";
  const livePrice = position.livePrice;

  // Active exit signal tracking: { confidence: number, weight: number, name: string }
  const signals: { confidence: number; weight: number; name: string }[] = [];

  // 1. Trend Reversal (EMA Death/Golden Cross)
  if (indicators.ema50 !== null && indicators.ema200 !== null) {
    if (isLong && indicators.ema50 < indicators.ema200) {
      signals.push({
        confidence: 85,
        weight: 0.25,
        name: "EMA Death Cross (EMA50 crossed below EMA200)",
      });
    } else if (!isLong && indicators.ema50 > indicators.ema200) {
      signals.push({
        confidence: 85,
        weight: 0.25,
        name: "EMA Golden Cross (EMA50 crossed above EMA200)",
      });
    }
  }

  // 2. Market Regime Shift (Opposing Trend)
  if (indicators.regime) {
    const regime = indicators.regime.toLowerCase();
    if (isLong && regime.includes("down")) {
      signals.push({
        confidence: 80,
        weight: 0.20,
        name: "Market regime shifted to Bearish (Trending Down)",
      });
    } else if (!isLong && regime.includes("up")) {
      signals.push({
        confidence: 80,
        weight: 0.20,
        name: "Market regime shifted to Bullish (Trending Up)",
      });
    }
  }

  // 3. Momentum Collapse (MACD Histogram crossover or divergence)
  if (indicators.macd !== null) {
    const hist = indicators.macd.histogram;
    const prevHist = indicators.macdPrev?.histogram ?? hist;

    if (isLong && hist < 0 && hist < prevHist) {
      signals.push({
        confidence: 70,
        weight: 0.15,
        name: "MACD momentum collapse (histogram is negative and declining)",
      });
    } else if (!isLong && hist > 0 && hist > prevHist) {
      signals.push({
        confidence: 70,
        weight: 0.15,
        name: "MACD momentum collapse (histogram is positive and rising)",
      });
    }
  }

  // 4. Candlestick Pattern Reversals
  if (indicators.candlestickBias !== 0) {
    const bias = indicators.candlestickBias;
    if (isLong && bias < -40) {
      signals.push({
        confidence: Math.abs(bias),
        weight: 0.15,
        name: `Bearish candlestick pattern detected (${indicators.candlestickCategory || "reversal"})`,
      });
    } else if (!isLong && bias > 40) {
      signals.push({
        confidence: bias,
        weight: 0.15,
        name: `Bullish candlestick pattern detected (${indicators.candlestickCategory || "reversal"})`,
      });
    }
  }

  // 5. Support/Resistance Breakdown (using Bollinger Bands)
  if (indicators.bb !== null) {
    const lower = indicators.bb.lower;
    const upper = indicators.bb.upper;
    if (isLong && livePrice < lower) {
      signals.push({
        confidence: 75,
        weight: 0.15,
        name: "Bollinger Bands breakdown (price broke below lower band)",
      });
    } else if (!isLong && livePrice > upper) {
      signals.push({
        confidence: 75,
        weight: 0.15,
        name: "Bollinger Bands breakout (price broke above upper band)",
      });
    }
  }

  // 6. RSI Breakdown
  if (indicators.rsi14 !== null) {
    const rsi = indicators.rsi14;
    if (isLong && rsi < 35) {
      signals.push({
        confidence: 65,
        weight: 0.10,
        name: `RSI momentum breakdown (RSI is low at ${rsi.toFixed(1)})`,
      });
    } else if (!isLong && rsi > 65) {
      signals.push({
        confidence: 65,
        weight: 0.10,
        name: `RSI momentum breakdown (RSI is high at ${rsi.toFixed(1)})`,
      });
    }
  }

  // 7. Volume Climax against trade direction
  if (indicators.volume > 0 && indicators.avgVolume > 0) {
    const isHighVolume = indicators.volume > indicators.avgVolume * 1.8;
    const inLoss = isLong ? livePrice < position.entryPrice : livePrice > position.entryPrice;
    if (isHighVolume && inLoss) {
      signals.push({
        confidence: 60,
        weight: 0.10,
        name: "Volume anomaly: high adverse volume suggests trend breakdown",
      });
    }
  }

  // If no signals are triggered, return early
  if (signals.length === 0) {
    return {
      triggerExit: false,
      confidence: 0,
      reason: "No exit signals detected",
    };
  }

  // Aggregate confidence weighted by signal weights
  let weightedSum = 0;
  let weightSum = 0;
  for (const sig of signals) {
    weightedSum += sig.confidence * sig.weight;
    weightSum += sig.weight;
  }

  let aggregateConfidence = Math.round(weightedSum / weightSum);

  // ─── News-Aware Exit Confidence Boost ──────────────
  let newsBoost = false;
  if (indicators.newsClass === "CRITICAL_RISK" || 
     (isLong && indicators.newsScore !== null && indicators.newsScore < -0.5) ||
     (!isLong && indicators.newsScore !== null && indicators.newsScore > 0.5)) {
    aggregateConfidence += 25;
    aggregateConfidence = Math.min(100, aggregateConfidence);
    newsBoost = true;
  }

  // Exit trigger threshold is 70
  const triggerExit = aggregateConfidence >= 70;

  let reason = "";
  if (triggerExit) {
    const activeReasons = signals.map(s => s.name);
    if (newsBoost) activeReasons.push("Adverse high-impact news detected (+25% confidence boost)");
    reason = `AI early exit triggered (confidence ${aggregateConfidence}%): ` + activeReasons.join("; ");
  }

  return {
    triggerExit,
    confidence: aggregateConfidence,
    reason,
  };
}
