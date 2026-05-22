import type {
  ManagedPositionContext,
  ManagementIndicators,
  TradeHealthScore,
  HealthScoreComponents,
} from "@/types/trade-management";
import type { Candle } from "@/types/market";

const EMA_ALPHA = 0.3;

export type TrendState =
  | "HEALTHY_PULLBACK"
  | "SIDEWAYS_CONSOLIDATION"
  | "WEAKENING_TREND"
  | "TREND_EXHAUSTION"
  | "STRONG_REVERSAL"
  | "LIQUIDATION_MOVE"
  | "STABLE_TREND";

/**
 * Counts consecutive adverse closed candles and calculates a weighted adverse score
 * where tiny candles have minimal penalty, large/high-volume candles have larger penalties,
 * and wicks in position favor reduce penalties.
 */
export function calculateWeightedAdverseCandlesScore(
  closedCandles: Candle[],
  side: "LONG" | "SHORT",
  atr: number,
  avgVolume: number
): { count: number; totalPenalty: number; explanation: string } {
  if (closedCandles.length === 0) {
    return { count: 0, totalPenalty: 0, explanation: "No closed candles available" };
  }

  let count = 0;
  let totalPenalty = 0;
  const penaltiesList: string[] = [];

  // Iterate backwards from the most recent closed candle
  for (let i = closedCandles.length - 1; i >= 0; i--) {
    const candle = closedCandles[i];
    const prevCandle = i > 0 ? closedCandles[i - 1] : null;

    let isAdverse = false;
    let basePenalty = 0;

    if (side === "LONG") {
      const isRed = candle.close < candle.open;
      const isDown = prevCandle ? candle.close < prevCandle.close : false;
      isAdverse = isRed || isDown;
      if (isAdverse) {
        basePenalty = 4;
        if (isRed) basePenalty += 2;
        if (isDown) basePenalty += 2;
      }
    } else {
      const isGreen = candle.close > candle.open;
      const isUp = prevCandle ? candle.close > prevCandle.close : false;
      isAdverse = isGreen || isUp;
      if (isAdverse) {
        basePenalty = 4;
        if (isGreen) basePenalty += 2;
        if (isUp) basePenalty += 2;
      }
    }

    if (isAdverse) {
      count++;
      
      // 1. Volatility/Size multiplier (ignoring micro-movements)
      const bodySize = Math.abs(candle.close - candle.open);
      let volMult = 1.0;
      if (bodySize > 1.5 * atr) {
        volMult = 1.8; // large adverse candle
      } else if (bodySize < 0.3 * atr) {
        volMult = 0.25; // micro noise filter
      }

      // 2. Volume multiplier
      const volRatio = avgVolume > 0 ? candle.volume / avgVolume : 1.0;
      let volumeMult = 1.0;
      if (volRatio > 1.8) {
        volumeMult = 1.5;
      } else if (volRatio < 0.5) {
        volumeMult = 0.5;
      }

      // 3. Wick rejection vs Support
      const candleBody = Math.abs(candle.close - candle.open);
      const upperWick = candle.high - Math.max(candle.open, candle.close);
      const lowerWick = Math.min(candle.open, candle.close) - candle.low;
      let wickPenalty = 0;
      let wickMult = 1.0;

      if (side === "LONG") {
        if (upperWick > candleBody * 1.2 && upperWick > atr * 0.3) {
          wickPenalty = 3; // rejecting upward movement
        }
        if (lowerWick > candleBody * 1.2 && lowerWick > atr * 0.3) {
          wickMult = 0.5; // lower shadow supports LONG (cutting penalty in half)
        }
      } else {
        if (lowerWick > candleBody * 1.2 && lowerWick > atr * 0.3) {
          wickPenalty = 3; // rejecting downward movement
        }
        if (upperWick > candleBody * 1.2 && upperWick > atr * 0.3) {
          wickMult = 0.5; // upper shadow supports SHORT (cutting penalty in half)
        }
      }

      const candlePenalty = (basePenalty + wickPenalty) * volMult * volumeMult * wickMult;
      totalPenalty += candlePenalty;
      
      penaltiesList.push(`[c${count}: ${candlePenalty.toFixed(1)}% penalty (base=${basePenalty}, volMult=${volMult.toFixed(2)}, volRatio=${volRatio.toFixed(1)}, wickMult=${wickMult})]`);
    } else {
      break; // consecutive adverse chain broken
    }
  }

  const roundedPenalty = Math.round(totalPenalty);
  return {
    count,
    totalPenalty: roundedPenalty,
    explanation: count > 0 
      ? `${count} consecutive adverse candles (total penalty: ${roundedPenalty}%): ${penaltiesList.join(", ")}`
      : "No consecutive adverse candles."
  };
}

/**
 * Detects structural deterioration in market highs/lows, EMA support, and VWAP bounds.
 */
export function detectStructureDeterioration(
  closedCandles: Candle[],
  side: "LONG" | "SHORT",
  indicators: ManagementIndicators
): { deteriorated: boolean; penalty: number; reasons: string[] } {
  const reasons: string[] = [];
  let totalPenalty = 0;
  if (closedCandles.length < 3) return { deteriorated: false, penalty: 0, reasons };

  const isLong = side === "LONG";
  const last = closedCandles[closedCandles.length - 1];
  const prev = closedCandles[closedCandles.length - 2];
  const prev2 = closedCandles[closedCandles.length - 3];
  const vwap = indicators.vwap;
  const atr = indicators.atr14 ?? (last.close * 0.015);

  // 1. Lower Highs & Lower Lows
  if (isLong) {
    if (last.high < prev.high && prev.high < prev2.high && last.low < prev.low) {
      reasons.push("Successive lower highs and lower lows (bearish structure)");
      totalPenalty += 12;
    }
  } else {
    if (last.low > prev.low && prev.low > prev2.low && last.high > prev.high) {
      reasons.push("Successive higher lows and higher highs (bullish structure)");
      totalPenalty += 12;
    }
  }

  // 2. EMA50 Loss
  if (indicators.ema50 !== null) {
    if (isLong && last.close < indicators.ema50) {
      reasons.push("Closed below EMA50 support");
      totalPenalty += 10;
    } else if (!isLong && last.close > indicators.ema50) {
      reasons.push("Closed above EMA50 resistance");
      totalPenalty += 10;
    }
  }

  // 3. VWAP Rejection
  if (vwap !== null) {
    if (isLong && last.high > vwap && last.close < vwap) {
      reasons.push("VWAP reclaim rejected (upper wick pierced VWAP but closed below)");
      totalPenalty += 8;
    } else if (!isLong && last.low < vwap && last.close > vwap) {
      reasons.push("VWAP reclaim rejected (lower wick pierced VWAP but closed above)");
      totalPenalty += 8;
    }
  }

  // 4. Failed Bounce
  if (indicators.ema50 !== null) {
    if (isLong && prev.low > indicators.ema50 && prev.close > prev.open && last.close < prev.low) {
      reasons.push("Failed EMA bounce (previous candle bounced but current candle broke its low)");
      totalPenalty += 10;
    } else if (!isLong && prev.high < indicators.ema50 && prev.close < prev.open && last.close > prev.high) {
      reasons.push("Failed EMA bounce (previous candle rejected resistance but current candle broke its high)");
      totalPenalty += 10;
    }
  }

  // 5. Momentum divergence
  const isRsiDecaying = indicators.rsi14 !== null &&
    (isLong ? indicators.rsi14 < 48 : indicators.rsi14 > 52);
  const isMacdDecaying = indicators.macd !== null && indicators.macdPrev !== null &&
    (isLong ? (indicators.macd.histogram < 0 && indicators.macd.histogram < indicators.macdPrev.histogram)
             : (indicators.macd.histogram > 0 && indicators.macd.histogram > indicators.macdPrev.histogram));
  if (isRsiDecaying && isMacdDecaying) {
    reasons.push("Dual RSI/MACD negative momentum alignment");
    totalPenalty += 8;
  }

  return {
    deteriorated: totalPenalty > 0,
    penalty: totalPenalty,
    reasons,
  };
}

/**
 * Classifies current price action relative to the position side.
 */
export function classifyTrendState(
  position: ManagedPositionContext,
  indicators: ManagementIndicators,
  closedCandles: Candle[]
): TrendState {
  if (closedCandles.length < 2) return "STABLE_TREND";

  const isLong = position.side === "LONG";
  const livePrice = position.livePrice;
  const atr = indicators.atr14 ?? (livePrice * 0.015);

  const lastCandle = closedCandles[closedCandles.length - 1];
  const prevCandle = closedCandles[closedCandles.length - 2];

  const lastCandleMove = lastCandle.close - lastCandle.open;
  const isLastAdverse = isLong ? lastCandleMove < 0 : lastCandleMove > 0;
  const isExtremeAdverseMove = isLastAdverse && Math.abs(lastCandleMove) > 2.5 * atr;
  const isVolumeExplosion = indicators.volume > indicators.avgVolume * 2.0;

  // 1. LIQUIDATION MOVE
  if (isExtremeAdverseMove && isVolumeExplosion) {
    return "LIQUIDATION_MOVE";
  }

  // 2. STRONG REVERSAL
  const isPriceCrossedEMA50 = indicators.ema50 !== null &&
    (isLong ? lastCandle.close < indicators.ema50 : lastCandle.close > indicators.ema50);
  const isMACDOpposing = indicators.macd !== null &&
    (isLong ? indicators.macd.histogram < 0 : indicators.macd.histogram > 0);
  
  const consecutiveAdverse = calculateConsecutiveAdverseCandles(closedCandles, position.side);
  const isAdverseVolumeHigh = indicators.volume > indicators.avgVolume * 1.5 && isLastAdverse;

  if (
    (isPriceCrossedEMA50 && isMACDOpposing && isLastAdverse) ||
    (consecutiveAdverse >= 3 && (isPriceCrossedEMA50 || isAdverseVolumeHigh))
  ) {
    return "STRONG_REVERSAL";
  }

  // 3. TREND EXHAUSTION
  const isExtremeRSI = indicators.rsi14 !== null &&
    (isLong ? indicators.rsi14 > 75 : indicators.rsi14 < 25);
  
  const candleBody = Math.abs(lastCandle.close - lastCandle.open);
  const upperWick = lastCandle.high - Math.max(lastCandle.open, lastCandle.close);
  const lowerWick = Math.min(lastCandle.open, lastCandle.close) - lastCandle.low;

  const hasExhaustionWick = isLong
    ? (upperWick > candleBody * 1.5 && upperWick > atr * 0.5)
    : (lowerWick > candleBody * 1.5 && lowerWick > atr * 0.5);

  if (isExtremeRSI && (hasExhaustionWick || (isVolumeExplosion && isLastAdverse))) {
    return "TREND_EXHAUSTION";
  }

  // 4. SIDEWAYS CONSOLIDATION
  const isChoppyRegime = indicators.regime?.toLowerCase().includes("choppy") ||
    indicators.regime?.toLowerCase().includes("sideways") ||
    indicators.regime?.toLowerCase().includes("range");
  const isLowADX = indicators.adx14 !== null && indicators.adx14 <= 20;
  const isTightBB = indicators.bb !== null && (indicators.bb.upper - indicators.bb.lower) < 2.0 * atr;

  if (isLowADX || isChoppyRegime || isTightBB) {
    return "SIDEWAYS_CONSOLIDATION";
  }

  // 5. HEALTHY PULLBACK
  const isBelowAvgVolume = indicators.volume < indicators.avgVolume * 1.1;
  const isEMAStructureIntact = indicators.ema50 !== null &&
    (isLong ? lastCandle.close > indicators.ema50 : lastCandle.close < indicators.ema50);
  const hasSupportWick = isLong
    ? (lowerWick > candleBody * 1.2 && lowerWick > atr * 0.3)
    : (upperWick > candleBody * 1.2 && upperWick > atr * 0.3);

  if (isLastAdverse && isEMAStructureIntact && (isBelowAvgVolume || hasSupportWick) && consecutiveAdverse <= 2) {
    return "HEALTHY_PULLBACK";
  }

  // 6. WEAKENING TREND
  const isRsiDecaying = indicators.rsi14 !== null &&
    (isLong ? indicators.rsi14 < 55 : indicators.rsi14 > 45);
  const isMacdDecaying = indicators.macd !== null && indicators.macdPrev !== null &&
    (isLong ? (indicators.macd.histogram < indicators.macdPrev.histogram) : (indicators.macd.histogram > indicators.macdPrev.histogram));

  if (isLastAdverse && (isRsiDecaying || isMacdDecaying)) {
    return "WEAKENING_TREND";
  }

  return "STABLE_TREND";
}

/**
 * Returns the count of consecutive adverse closed candles.
 */
export function calculateConsecutiveAdverseCandles(closedCandles: Candle[], side: "LONG" | "SHORT"): number {
  if (closedCandles.length === 0) return 0;
  let count = 0;
  for (let i = closedCandles.length - 1; i >= 0; i--) {
    const candle = closedCandles[i];
    const prevCandle = i > 0 ? closedCandles[i - 1] : null;

    let isAdverse = false;
    if (side === "LONG") {
      isAdverse = (candle.close < candle.open) || (prevCandle ? candle.close < prevCandle.close : false);
    } else {
      isAdverse = (candle.close > candle.open) || (prevCandle ? candle.close > prevCandle.close : false);
    }

    if (isAdverse) {
      count++;
    } else {
      break;
    }
  }
  return count;
}

/**
 * Helper to parse the timeframe string into milliseconds.
 */
function parseTimeframeToMs(timeframe: string): number {
  const num = parseInt(timeframe, 10);
  if (isNaN(num)) return 5 * 60 * 1000; // default 5m
  if (timeframe.endsWith("m")) return num * 60 * 1000;
  if (timeframe.endsWith("H") || timeframe.endsWith("h")) return num * 60 * 60 * 1000;
  if (timeframe.endsWith("D") || timeframe.endsWith("d")) return num * 24 * 60 * 60 * 1000;
  return 5 * 60 * 1000;
}

/**
 * Calculates a dynamic confidence score (0-100) based on trend alignment, candle confirmation,
 * structural breakdown, news decay, higher timeframe confirmation, and position quality.
 */
export function calculateDynamicConfidence(
  position: ManagedPositionContext,
  indicators: ManagementIndicators,
  closedCandles: Candle[],
  timeframe: string = "5m"
): { confidence: number; trendState: TrendState; trace: string[] } {
  let score = 100;
  const trace: string[] = [];
  const side = position.side;
  const atr = indicators.atr14 ?? (position.livePrice * 0.015);
  const avgVolume = indicators.avgVolume;

  // 1. Calculate candle elapsed since creation (Trend Age / Maturity)
  const createdTime = new Date(position.createdAt).getTime();
  const timeElapsed = Date.now() - createdTime;
  const timeframeMs = parseTimeframeToMs(timeframe);
  const candlesElapsed = Math.floor(timeElapsed / timeframeMs);
  trace.push(`Trend age: ${candlesElapsed} candles elapsed`);

  // 2. Classify Trend State
  const trendState = classifyTrendState(position, indicators, closedCandles);
  trace.push(`Trend State: ${trendState}`);

  const trendPenalties: Record<TrendState, number> = {
    STABLE_TREND: 0,
    HEALTHY_PULLBACK: 5,
    SIDEWAYS_CONSOLIDATION: 10,
    WEAKENING_TREND: 15,
    TREND_EXHAUSTION: 25,
    STRONG_REVERSAL: 40,
    LIQUIDATION_MOVE: 60,
  };
  const baseTrendPenalty = trendPenalties[trendState];
  if (baseTrendPenalty > 0) {
    score -= baseTrendPenalty;
    trace.push(`Penalty -${baseTrendPenalty}% for Trend State: ${trendState}`);
  }

  // 3. Candle Confirmation & Weighted Penalties
  const candleScoring = calculateWeightedAdverseCandlesScore(closedCandles, side, atr, avgVolume);
  if (candleScoring.totalPenalty > 0) {
    score -= candleScoring.totalPenalty;
    trace.push(`Adverse candles: ${candleScoring.explanation}`);
  }

  // 4. Market Structure Deterioration
  const structure = detectStructureDeterioration(closedCandles, side, indicators);
  if (structure.deteriorated) {
    score -= structure.penalty;
    trace.push(`Market Structure Deterioration penalty -${structure.penalty}% due to: ${structure.reasons.join("; ")}`);
  }

  // 5. News Decay Timer
  if (indicators.newsScore !== null) {
    const isLong = side === "LONG";
    const isAdverseNews = isLong ? indicators.newsScore < 0 : indicators.newsScore > 0;
    
    if (isAdverseNews || indicators.newsClass === "CRITICAL_RISK") {
      let baseNewsPenalty = 0;
      if (indicators.newsClass === "CRITICAL_RISK") {
        baseNewsPenalty = 40;
      } else {
        baseNewsPenalty = Math.round(Math.abs(indicators.newsScore) * 20);
      }

      // Compute decay factor
      let newsDecay = 1.0;
      if (indicators.newsTimestamp) {
        const ageMins = (Date.now() - indicators.newsTimestamp) / 60000;
        if (ageMins <= 15) {
          newsDecay = 1.0;
        } else if (ageMins <= 60) {
          newsDecay = 1.0 - ((ageMins - 15) / 45) * 0.5; // decays 1.0 -> 0.5
        } else if (ageMins <= 240) {
          newsDecay = 0.5 - ((ageMins - 60) / 180) * 0.4; // decays 0.5 -> 0.1
        } else {
          newsDecay = 0.1;
        }

        if (indicators.newsClass === "CRITICAL_RISK") {
          newsDecay = Math.max(0.5, newsDecay); // clamp minimum for critical risk
        }
      }

      const finalNewsPenalty = Math.round(baseNewsPenalty * newsDecay);
      score -= finalNewsPenalty;
      trace.push(`News penalty -${finalNewsPenalty}% (base=${baseNewsPenalty}%, decay=${newsDecay.toFixed(2)})`);
    }
  }

  // 6. Higher Timeframe Confirmation (Multi-Timeframe filter)
  // If HTF is in agreement, we cushion penalties.
  // Note: we fetch HTF alignment from indicators.regime or check standard indicators.
  const isHTFTrendFavorable = indicators.regime ? (
    side === "LONG" ? !indicators.regime.toLowerCase().includes("down") : !indicators.regime.toLowerCase().includes("up")
  ) : true;

  if (isHTFTrendFavorable) {
    // Favorable HTF cushions penalties by 30%
    const penaltyDeduction = Math.round((100 - score) * 0.3);
    if (penaltyDeduction > 0) {
      score += penaltyDeduction;
      trace.push(`Cushioned penalties by +${penaltyDeduction}% due to favorable Higher Timeframe alignment`);
    }
  } else {
    // Opposing HTF trend adds another penalty
    score -= 10;
    trace.push(`Penalty -10% due to opposing macro timeframe trend`);
  }

  // 7. Position Quality Adjustments
  const setupQuality = position.setupQuality || "C";
  const qualityScore = position.qualityScore || 50;
  
  if (setupQuality === "A+" || setupQuality === "A" || qualityScore >= 80) {
    // High quality positions get an additional cushion (15% reduction in total penalties)
    const cushion = Math.round((100 - score) * 0.2);
    if (cushion > 0) {
      score += cushion;
      trace.push(`High-quality position bonus: Cushioned penalties by +${cushion}% (grade: ${setupQuality})`);
    }
  } else if (setupQuality === "C" || qualityScore < 60) {
    // Low quality positions get penalized more
    score -= 5;
    trace.push(`Low-quality position penalty: -5% (grade: ${setupQuality})`);
  }

  // 8. Trend continuation detection (Positive Continuation Detector)
  // If price action bounces off EMA50, reclaims VWAP, or volume recovers, restore some confidence
  const lastCandle = closedCandles[closedCandles.length - 1];
  const prevCandle = closedCandles[closedCandles.length - 2];
  
  if (lastCandle && prevCandle) {
    const isGreen = lastCandle.close > lastCandle.open;
    const isUp = lastCandle.close > prevCandle.close;
    const isContinuationCandle = side === "LONG" ? (isGreen || isUp) : (!isGreen || !isUp);

    const isPriceReclaimedEMA50 = indicators.ema50 !== null &&
      (side === "LONG" ? (lastCandle.close > indicators.ema50 && prevCandle.close < indicators.ema50)
                       : (lastCandle.close < indicators.ema50 && prevCandle.close > indicators.ema50));

    const isPriceReclaimedVWAP = indicators.vwap !== null &&
      (side === "LONG" ? (lastCandle.close > indicators.vwap && prevCandle.close < indicators.vwap)
                       : (lastCandle.close < indicators.vwap && prevCandle.close > indicators.vwap));

    if (isContinuationCandle && (isPriceReclaimedEMA50 || isPriceReclaimedVWAP || (indicators.volume > indicators.avgVolume * 1.2))) {
      const recoveryBonus = 15;
      score = Math.min(100, score + recoveryBonus);
      trace.push(`Positive Trend Continuation detected (+${recoveryBonus}% confidence boost)`);
    }
  }

  // Clamp final score
  const finalScore = Math.max(0, Math.min(100, score));
  trace.push(`Final Confidence Score: ${finalScore}%`);

  return {
    confidence: finalScore,
    trendState,
    trace,
  };
}

/**
 * Legacy compatibility entry point. Computes base health score.
 */
export function calculateHealthScore(
  position: ManagedPositionContext,
  indicators: ManagementIndicators
): TradeHealthScore {
  const isLong = position.side === "LONG";
  const livePrice = position.livePrice;

  // 1. EMA Structure
  let emaStructure = 50;
  if (indicators.ema50 !== null && indicators.ema200 !== null) {
    let score = 0;
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

  // 2. RSI Strength
  let rsiStrength = 50;
  if (indicators.rsi14 !== null) {
    const rsi = indicators.rsi14;
    if (isLong) {
      if (rsi >= 45 && rsi <= 70) rsiStrength = 100;
      else if (rsi > 70 && rsi <= 85) rsiStrength = 75;
      else if (rsi > 85) rsiStrength = 30;
      else if (rsi >= 30 && rsi < 45) rsiStrength = 55;
      else rsiStrength = 25;
    } else {
      if (rsi >= 30 && rsi <= 55) rsiStrength = 100;
      else if (rsi < 30 && rsi >= 15) rsiStrength = 75;
      else if (rsi < 15) rsiStrength = 30;
      else if (rsi > 55 && rsi <= 70) rsiStrength = 55;
      else rsiStrength = 25;
    }
  }

  // 3. MACD Momentum
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

  // 4. VWAP Position
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

  // 5. Volume Behavior
  let volumeBehavior = 65;
  if (indicators.volume > 0 && indicators.avgVolume > 0) {
    const isAboveAvg = indicators.volume > indicators.avgVolume;
    if (isAboveAvg) {
      const inProfit = isLong ? livePrice > position.entryPrice : livePrice < position.entryPrice;
      volumeBehavior = inProfit ? 100 : 35;
    } else {
      volumeBehavior = 65;
    }
  }

  // 6. Volatility
  let volatility = 50;
  if (indicators.atrPct !== null) {
    const atrPct = indicators.atrPct;
    if (atrPct > 5.0) {
      volatility = 40;
    } else if (atrPct >= 0.5 && atrPct <= 3.0) {
      volatility = 100;
    } else if (atrPct < 0.1) {
      volatility = 55;
    } else {
      volatility = 75;
    }
  }

  // 7. Candle Structure
  let candleStructure = 50;
  if (indicators.candlestickBias !== 0) {
    const bias = indicators.candlestickBias;
    if (isLong) {
      candleStructure = Math.min(100, Math.max(0, 50 + bias / 2));
    } else {
      candleStructure = Math.min(100, Math.max(0, 50 - bias / 2));
    }
  }

  // 8. Market Regime
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

  // 9. News Sentiment
  let newsSentiment = 50;
  if (indicators.newsScore !== null) {
    const score = indicators.newsScore;
    if (isLong) {
      newsSentiment = Math.min(100, Math.max(0, 50 + score * 50));
    } else {
      newsSentiment = Math.min(100, Math.max(0, 50 - score * 50));
    }
  }
  if (indicators.newsClass === "CRITICAL_RISK") {
    newsSentiment = Math.min(newsSentiment, 15);
  }

  // 10. PnL Behavior
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
    pnlBehavior = 15;
  }

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

  const history = position.managementMeta?.healthHistory ?? [];
  let smoothedScore = overall;
  if (history.length > 0) {
    const lastScore = history[history.length - 1];
    smoothedScore = Math.round(EMA_ALPHA * overall + (1 - EMA_ALPHA) * lastScore);
  }

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
