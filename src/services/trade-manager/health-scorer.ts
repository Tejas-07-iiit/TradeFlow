import type {
  ManagedPositionContext,
  ManagementIndicators,
  TradeHealthScore,
  HealthScoreComponents,
} from "@/types/trade-management";

const EMA_ALPHA = 0.3;

/**
 * Computes the trade health score (0-100) based on technical indicators,
 * candlestick patterns, news sentiment, and P&L behavior.
 */
export function calculateHealthScore(
  position: ManagedPositionContext,
  indicators: ManagementIndicators
): TradeHealthScore {
  const isLong = position.side === "LONG";
  const livePrice = position.livePrice;

  // 1. EMA Structure (15% weight)
  let emaStructure = 50;
  if (indicators.ema50 !== null && indicators.ema200 !== null) {
    let score = 0;
    // Price relative to EMA50
    if (isLong) {
      score += livePrice > indicators.ema50 ? 50 : 10;
      score += livePrice > indicators.ema200 ? 30 : 10;
      score += indicators.ema50 > indicators.ema200 ? 20 : 0;
    } else {
      score += livePrice < indicators.ema50 ? 50 : 10;
      score += livePrice < indicators.ema200 ? 30 : 10;
      score += indicators.ema50 < indicators.ema200 ? 20 : 0;
    }
    emaStructure = score;
  }

  // 2. RSI Strength (12% weight)
  let rsiStrength = 50;
  if (indicators.rsi14 !== null) {
    const rsi = indicators.rsi14;
    if (isLong) {
      if (rsi >= 45 && rsi <= 70) rsiStrength = 100;
      else if (rsi > 70 && rsi <= 85) rsiStrength = 75; // overbought but strong
      else if (rsi > 85) rsiStrength = 30;              // extreme bubble
      else if (rsi >= 30 && rsi < 45) rsiStrength = 55; // weak/oversold recovery
      else rsiStrength = 25;                            // deep oversold/bearish structure
    } else {
      if (rsi >= 30 && rsi <= 55) rsiStrength = 100;
      else if (rsi < 30 && rsi >= 15) rsiStrength = 75;  // oversold but strong momentum
      else if (rsi < 15) rsiStrength = 30;               // capitulation
      else if (rsi > 55 && rsi <= 70) rsiStrength = 55;  // weak pullback
      else rsiStrength = 25;                            // overbought/bullish structure
    }
  }

  // 3. MACD Momentum (12% weight)
  let macdMomentum = 50;
  if (indicators.macd !== null) {
    const hist = indicators.macd.histogram;
    const prevHist = indicators.macdPrev?.histogram ?? hist;
    let score = 0;
    if (isLong) {
      score += hist > 0 ? 60 : 10;
      score += hist >= prevHist ? 40 : 10;
    } else {
      score += hist < 0 ? 60 : 10;
      score += hist <= prevHist ? 40 : 10;
    }
    macdMomentum = score;
  }

  // 4. VWAP Position (10% weight)
  let vwapPosition = 50;
  if (indicators.vwap !== null) {
    let score = 0;
    if (isLong) {
      score += livePrice > indicators.vwap ? 70 : 10;
      score += indicators.vwapSlope >= 0 ? 30 : 0;
    } else {
      score += livePrice < indicators.vwap ? 70 : 10;
      score += indicators.vwapSlope <= 0 ? 30 : 0;
    }
    vwapPosition = score;
  }

  // 5. Volume Behavior (8% weight)
  let volumeBehavior = 65; // default moderate score
  if (indicators.volume > 0 && indicators.avgVolume > 0) {
    const isAboveAvg = indicators.volume > indicators.avgVolume;
    // Simple candle direction detection based on indicators (bias or regime could assist)
    // For now we check if volume is high on trade-aligned days. If we don't have candle close,
    // we use default mapping.
    if (isAboveAvg) {
      // High volume on trend direction is good
      // We can check if livePrice is in profit direction from entry
      const inProfit = isLong ? livePrice > position.entryPrice : livePrice < position.entryPrice;
      volumeBehavior = inProfit ? 100 : 35;
    } else {
      volumeBehavior = 65; // quiet consolidation
    }
  }

  // 6. Volatility (8% weight)
  let volatility = 50;
  if (indicators.atrPct !== null) {
    const atrPct = indicators.atrPct;
    if (atrPct > 5.0) {
      volatility = 40; // Extremely high volatility is risky
    } else if (atrPct >= 0.5 && atrPct <= 3.0) {
      volatility = 100; // Perfect trading range
    } else if (atrPct < 0.1) {
      volatility = 55; // Extremely low volatility (illiquid/flat)
    } else {
      volatility = 75; // Moderate
    }
  }

  // 7. Candle Structure (10% weight)
  let candleStructure = 50;
  if (indicators.candlestickBias !== 0) {
    const bias = indicators.candlestickBias; // -100 to +100
    if (isLong) {
      candleStructure = Math.min(100, Math.max(0, 50 + bias / 2));
    } else {
      candleStructure = Math.min(100, Math.max(0, 50 - bias / 2));
    }
  }

  // 8. Market Regime (10% weight)
  let marketRegime = 50;
  if (indicators.regime) {
    const regime = indicators.regime.toLowerCase();
    if (isLong) {
      if (regime.includes("up")) marketRegime = 100;
      else if (regime.includes("down")) marketRegime = 20;
      else if (regime.includes("choppy")) marketRegime = 60;
      else if (regime.includes("volatility")) marketRegime = 40;
    } else {
      if (regime.includes("down")) marketRegime = 100;
      else if (regime.includes("up")) marketRegime = 20;
      else if (regime.includes("choppy")) marketRegime = 60;
      else if (regime.includes("volatility")) marketRegime = 40;
    }
  }

  // 9. News Sentiment (8% weight)
  let newsSentiment = 50;
  if (indicators.newsScore !== null) {
    const score = indicators.newsScore; // -1 to 1
    if (isLong) {
      newsSentiment = Math.min(100, Math.max(0, 50 + score * 50));
    } else {
      newsSentiment = Math.min(100, Math.max(0, 50 - score * 50));
    }
  }
  // Veto overlay for critical news risk
  if (indicators.newsClass === "CRITICAL_RISK") {
    newsSentiment = Math.min(newsSentiment, 15);
  }

  // 10. PnL Behavior (7% weight)
  let pnlBehavior = 70;
  const pnlPct = position.unrealizedPnlPct;
  if (pnlPct >= 5.0) {
    pnlBehavior = 100;
  } else if (pnlPct > 0) {
    pnlBehavior = 85;
  } else if (pnlPct >= -2.0) {
    pnlBehavior = 60;
  } else if (pnlPct >= -5.0) {
    pnlBehavior = 40;
  } else {
    pnlBehavior = 15; // deep drawdown
  }

  // Calculate overall weighted score
  const components: HealthScoreComponents = {
    emaStructure,
    rsiStrength,
    macdMomentum,
    vwapPosition,
    volumeBehavior,
    volatility,
    candleStructure,
    marketRegime,
    newsSentiment,
    pnlBehavior,
  };

  const weightedSum =
    components.emaStructure * 0.15 +
    components.rsiStrength * 0.12 +
    components.macdMomentum * 0.12 +
    components.vwapPosition * 0.10 +
    components.volumeBehavior * 0.08 +
    components.volatility * 0.08 +
    components.candleStructure * 0.10 +
    components.marketRegime * 0.10 +
    components.newsSentiment * 0.08 +
    components.pnlBehavior * 0.07;

  const overall = Math.round(weightedSum);

  // Smooth the overall score using historical data
  const history = position.managementMeta?.healthHistory ?? [];
  let smoothedScore = overall;
  if (history.length > 0) {
    const lastScore = history[history.length - 1];
    smoothedScore = Math.round(EMA_ALPHA * overall + (1 - EMA_ALPHA) * lastScore);
  }

  // Trend detection
  let trend: "improving" | "stable" | "deteriorating" = "stable";
  if (history.length > 0) {
    const lastScore = history[history.length - 1];
    const diff = smoothedScore - lastScore;
    if (diff > 1) {
      trend = "improving";
    } else if (diff < -1) {
      trend = "deteriorating";
    }
  }

  return {
    overall,
    components,
    trend,
    smoothedScore,
  };
}
