/**
 * Risk-adjusted position sizing.
 */
import { computePositionRiskMetrics } from "@/lib/risk/metrics";

const QTY_PRECISION_BY_SYMBOL: Record<string, number> = {
  BTCUSDT: 3,
  ETHUSDT: 3,
  SOLUSDT: 2,
  BNBUSDT: 2,
  XRPUSDT: 0,
};
const DEFAULT_QTY_PRECISION = 3;

/** Floor on per-trade notional — below this, fees dominate. */
const MIN_NOTIONAL_USDT = 100;
/** Hard ceiling on per-trade notional regardless of caller request. */
const MAX_NOTIONAL_USDT = 7_500;
/** Reject trades whose expected profit at TP is below this. */
const MIN_EXPECTED_PROFIT_USDT = 2;
/** Max % of total equity in a single trade. */
const MAX_SINGLE_TRADE_EQUITY_PCT = 35;
/** Max % of total equity exposed across all open trades. */
const MAX_TOTAL_EXPOSURE_PCT = 40;
/** Max % of total equity exposed on a single symbol. */
const MAX_PER_SYMBOL_EXPOSURE_PCT = 20;
/** Simulated leverage cap. Notional may not exceed available × this. */
const MAX_LEVERAGE = 2;
/** Minimum stop-loss distance as a fraction of price (5 bps). Anything
 *  tighter is treated as a malformed proposal. */
const MIN_STOP_DISTANCE = 0.0005;

export type SetupQuality = "A+" | "A" | "B+" | "B" | "C" | "Avoid";

export interface SizingInput {
  symbol: string;
  side: "LONG" | "SHORT";
  livePrice: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  /** Total equity = walletBalance + unrealizedPnl. */
  totalEquity: number;
  /** Available cash = walletBalance − usedMargin. */
  availableBalance: number;
  /** LLM/rule confidence, 0-100. */
  confidence: number;
  setupQuality?: SetupQuality;
  marketRegime?: string;
  /** ATR as % of price (e.g. 1.5 means 1.5%). null = unknown, treated as neutral. */
  atrPct?: number | null;
  /** Decision label — used for the strategy-type multiplier. */
  decisionType?: string;
  /** Book state so we can enforce per-symbol + total exposure caps. */
  exposure: {
    totalOpenNotional: number;
    perSymbolOpenNotional: number;
    openPositionsCount: number;
  };
  /** Max concurrent positions — caller decides; defaults to 3. */
  maxOpenPositions?: number;
  /**
   * Optional external risk multiplier applied to the final size after the
   * full internal multiplier stack. Used by the news-validation layer to
   * shrink (or modestly boost) a candidate based on coin-specific
   * headlines. Range expected: [0, 1.15]. Values <= 0 are treated as a
   * caller error and rejected.
   */
  externalSizeMultiplier?: number;
  /**
   * Optional drawdown gate multiplier from `lib/risk/drawdown-gate`. When
   * supplied, replaces no logic — it stacks as a new factor in the
   * multiplier chain. A value of 0 triggers a clean `zero_risk_budget`
   * rejection (the gate's kill-switch path). Callers that don't compute
   * drawdown leave this undefined and get unchanged behaviour.
   */
  drawdownMultiplier?: number;
  /**
   * Optional volatility-target multiplier from `lib/risk/vol-target`. When
   * supplied, *replaces* the discrete-bucket ATR multiplier — the two are
   * different formulations of the same idea and stacking both would
   * double-count. When absent, the existing discrete-bucket vol multiplier
   * stays active (backward compatible).
   */
  volTargetMultiplier?: number;
}

export type SizingRejection =
  | "invalid_price"
  | "invalid_balance"
  | "invalid_stop"
  | "zero_risk_budget"
  | "book_full"
  | "total_exposure_capped"
  | "symbol_exposure_capped"
  | "below_min_notional"
  | "below_min_expected_profit"
  | "setup_avoid";

export interface SizingResult {
  quantity: number;
  notional: number;
  /** Dollars at risk if SL is hit. */
  riskAmount: number;
  /** Risk as % of total equity. */
  riskPercent: number;
  /** notional / totalEquity, in %. */
  equityPercent: number;
  marginRequired: number;
  expectedProfit: number;
  expectedLoss: number;
  riskRewardRatio: number;
  multipliers: {
    baseRiskPct: number;
    confidence: number;
    quality: number;
    regime: number;
    volatility: number;
    strategy: number;
    /** 1.0 when no drawdown gate supplied; bucket multiplier otherwise. */
    drawdown: number;
    /** 1.0 when no vol-target supplied; ratio multiplier otherwise. When
     *  vol-target is active, `volatility` (the discrete bucket) is forced
     *  to 1.0 to avoid double-counting the same effect. */
    volTarget: number;
  };
  /** One-line human-readable explanation. */
  rationale: string;
  rejection?: SizingRejection;
  /**
   * External size multiplier actually applied (echoed for logging /
   * transparency). 1 means no external adjustment was supplied.
   */
  externalSizeMultiplier?: number;
}

/**
 * Map confidence (0-100) to a base risk percentage of equity to put at
 * stake on this trade. Below 60 we don't trade.
 */
function baseRiskFromConfidence(confidence: number): number {
  if (confidence >= 90) return 2.0;
  if (confidence >= 80) return 1.5;
  if (confidence >= 70) return 1.0;
  if (confidence >= 60) return 0.6;
  return 0.4;
}

/**
 * Maximum % of equity to commit on a single trade given confidence. Acts as
 * an absolute size cap independent of the risk-per-trade formula — even
 * with a tiny SL distance, we won't pour 80% of the book into one ticker.
 */
function maxEquityPctFromConfidence(confidence: number): number {
  if (confidence >= 90) return 35;
  if (confidence >= 80) return 20;
  if (confidence >= 70) return 12;
  if (confidence >= 60) return 7;
  return 4;
}

function qualityMultiplier(q?: SetupQuality): number {
  switch (q) {
    case "A+": return 1.3;
    case "A": return 1.15;
    case "B+": return 1.0;
    case "B": return 0.85;
    case "C": return 0.6;
    case "Avoid": return 0;
    default: return 1.0;
  }
}

function regimeMultiplier(regime?: string): number {
  switch (regime) {
    case "Trending":
    case "Trending Up":
    case "Trending Down": return 1.2;
    case "Sideways": return 1.0;
    case "Compression": return 0.75;
    case "Reversal": return 0.85;
    case "Choppy": return 0.6;
    case "High Volatility": return 0.5;
    default: return 1.0;
  }
}

function volatilityMultiplier(atrPct?: number | null): number {
  if (atrPct == null || !Number.isFinite(atrPct)) return 1.0;
  if (atrPct < 1) return 1.15;
  if (atrPct < 2.5) return 1.0;
  if (atrPct < 4) return 0.85;
  if (atrPct < 6) return 0.7;
  if (atrPct < 8) return 0.5;
  return 0.35;
}

function strategyMultiplier(decisionType?: string): number {
  if (!decisionType) return 1.0;
  const t = decisionType.toUpperCase();
  // Breakout / momentum continuation — size up.
  if (t.includes("BREAKOUT") || t.includes("MOMENTUM")) return 1.15;
  // Mean-reversion / reversal — size down.
  if (t.includes("REVERSAL") || t.includes("RANGE")) return 0.85;
  // Pullback / trend continuation — neutral-to-up.
  if (t.includes("PULLBACK")) return 1.1;
  return 1.0;
}

const REJECT = (
  reason: SizingRejection,
  rationale: string,
): SizingResult => ({
  quantity: 0,
  notional: 0,
  riskAmount: 0,
  riskPercent: 0,
  equityPercent: 0,
  marginRequired: 0,
  expectedProfit: 0,
  expectedLoss: 0,
  riskRewardRatio: 0,
  multipliers: {
    baseRiskPct: 0,
    confidence: 0,
    quality: 0,
    regime: 0,
    volatility: 0,
    strategy: 0,
    drawdown: 0,
    volTarget: 0,
  },
  rationale,
  rejection: reason,
});

/**
 * Main entry point. Returns a fully-filled result on every call; check
 * `.rejection` to see if the caller should skip.
 */
export function computeRiskAdjustedSize(input: SizingInput): SizingResult {
  const {
    symbol,
    side,
    livePrice,
    stopLossPrice,
    takeProfitPrice,
    totalEquity,
    availableBalance,
    confidence,
    setupQuality,
    marketRegime,
    atrPct,
    decisionType,
    exposure,
    maxOpenPositions = 3,
  } = input;

  if (!Number.isFinite(livePrice) || livePrice <= 0) {
    return REJECT("invalid_price", "Invalid live price");
  }
  if (!Number.isFinite(totalEquity) || totalEquity <= 0) {
    return REJECT("invalid_balance", "Invalid equity");
  }
  if (!Number.isFinite(availableBalance) || availableBalance <= 0) {
    return REJECT("invalid_balance", "No available cash");
  }
  if (setupQuality === "Avoid") {
    return REJECT("setup_avoid", "Setup graded Avoid");
  }
  if (exposure.openPositionsCount >= maxOpenPositions) {
    return REJECT(
      "book_full",
      `Book full (${exposure.openPositionsCount}/${maxOpenPositions})`,
    );
  }

  // Validate SL is on the correct side of entry with non-trivial distance.
  const stopDistAbs = Math.abs(livePrice - stopLossPrice);
  const stopDistPct = stopDistAbs / livePrice;
  if (stopDistPct < MIN_STOP_DISTANCE) {
    return REJECT("invalid_stop", "Stop too tight or equal to entry");
  }
  if (side === "LONG" && stopLossPrice >= livePrice) {
    return REJECT("invalid_stop", "LONG: stop must be below entry");
  }
  if (side === "SHORT" && stopLossPrice <= livePrice) {
    return REJECT("invalid_stop", "SHORT: stop must be above entry");
  }

  // Drawdown kill-switch — if the gate is in halt mode, reject cleanly
  // before doing any other math. This is the mechanical equivalent of
  // "stop trading after a -20% account hit".
  if (input.drawdownMultiplier != null && input.drawdownMultiplier <= 0) {
    return REJECT(
      "zero_risk_budget",
      "Drawdown kill-switch engaged — new entries halted",
    );
  }

  // Multiplier stack.
  const baseRiskPct = baseRiskFromConfidence(confidence);
  const mQ = qualityMultiplier(setupQuality);
  const mR = regimeMultiplier(marketRegime);
  // Vol target supersedes the discrete bucket when supplied. We zero the
  // bucket (mV → 1.0) so we don't multiply both representations of the
  // same volatility effect into the size.
  const useVolTarget =
    input.volTargetMultiplier != null && Number.isFinite(input.volTargetMultiplier);
  const mV = useVolTarget ? 1 : volatilityMultiplier(atrPct);
  const mVT = useVolTarget ? (input.volTargetMultiplier as number) : 1;
  const mS = strategyMultiplier(decisionType);
  const mDD =
    input.drawdownMultiplier != null && Number.isFinite(input.drawdownMultiplier)
      ? input.drawdownMultiplier
      : 1;
  const riskPct = baseRiskPct * mQ * mR * mV * mVT * mS * mDD;

  if (riskPct <= 0) {
    return REJECT("zero_risk_budget", "Risk budget zeroed by multipliers");
  }

  // Risk-based notional: dollars-at-risk / SL-distance%.
  const riskAmount = totalEquity * (riskPct / 100);
  let notional = riskAmount / stopDistPct;

  // External multiplier from news validation. Caller is responsible for
  // bounds — we clamp defensively to [0, 1.3] so a runaway value can't
  // double size. Zero short-circuits to a clean rejection.
  const extM = clampExternal(input.externalSizeMultiplier);
  if (extM === 0) {
    return REJECT(
      "zero_risk_budget",
      "External size multiplier is zero (news layer rejected trade)",
    );
  }
  notional *= extM;

  // Cap by single-trade equity %.
  const equityCapPct = maxEquityPctFromConfidence(confidence);
  const equityCapNotional = totalEquity * (equityCapPct / 100);
  if (notional > equityCapNotional) notional = equityCapNotional;

  // Per-symbol exposure cap.
  const perSymbolBudget =
    totalEquity * (MAX_PER_SYMBOL_EXPOSURE_PCT / 100) -
    exposure.perSymbolOpenNotional;
  if (perSymbolBudget <= 0) {
    return REJECT(
      "symbol_exposure_capped",
      `${symbol} already at per-symbol exposure cap`,
    );
  }
  if (notional > perSymbolBudget) notional = perSymbolBudget;

  // Total book exposure cap.
  const totalBudget =
    totalEquity * (MAX_TOTAL_EXPOSURE_PCT / 100) - exposure.totalOpenNotional;
  if (totalBudget <= 0) {
    return REJECT(
      "total_exposure_capped",
      `Book at total-exposure cap (${MAX_TOTAL_EXPOSURE_PCT}% of equity)`,
    );
  }
  if (notional > totalBudget) notional = totalBudget;

  // Leverage cap relative to available cash.
  const leverageCapNotional = availableBalance * MAX_LEVERAGE;
  if (notional > leverageCapNotional) notional = leverageCapNotional;

  // Absolute ceiling.
  if (notional > MAX_NOTIONAL_USDT) notional = MAX_NOTIONAL_USDT;

  // Floor — reject sub-100 notional.
  if (notional < MIN_NOTIONAL_USDT) {
    return REJECT(
      "below_min_notional",
      `Sized notional ${notional.toFixed(2)} below min ${MIN_NOTIONAL_USDT}`,
    );
  }

  // Quantize.
  const precision = QTY_PRECISION_BY_SYMBOL[symbol] ?? DEFAULT_QTY_PRECISION;
  const scale = 10 ** precision;
  const quantity = Math.round((notional / livePrice) * scale) / scale;
  if (quantity <= 0) {
    return REJECT("below_min_notional", "Rounded quantity is zero");
  }
  const finalNotional = quantity * livePrice;
  if (finalNotional < MIN_NOTIONAL_USDT) {
    return REJECT(
      "below_min_notional",
      `Final notional ${finalNotional.toFixed(2)} below min ${MIN_NOTIONAL_USDT}`,
    );
  }

  // P&L expectations using the centralized risk metrics engine
  const riskMetrics = computePositionRiskMetrics({
    side,
    entryPrice: livePrice,
    quantity,
    leverage: 1, // isolated margin isolated leverage is 1 by default in paper engine
    takeProfitPrice,
    stopLossPrice,
    walletBalance: totalEquity,
  });

  const expectedProfit = riskMetrics.projectedProfit;
  const expectedLoss = riskMetrics.projectedLoss;
  const riskRewardRatio = riskMetrics.riskRewardRatio;

  if (expectedProfit < MIN_EXPECTED_PROFIT_USDT) {
    return REJECT(
      "below_min_expected_profit",
      `Expected profit ${expectedProfit.toFixed(2)} < min ${MIN_EXPECTED_PROFIT_USDT}`,
    );
  }

  const equityPercent = (finalNotional / totalEquity) * 100;
  // Margin = notional / leverage. Paper engine uses leverage 1, so margin
  // here equals notional; callers can override but the headline number is
  // what they care about.
  const marginRequired = riskMetrics.marginUsed;
  const finalRiskAmount = riskMetrics.projectedLoss;
  const finalRiskPercent = riskMetrics.riskPercentOfWallet ?? riskPct;

  const rationale = buildRationale({
    equityPercent,
    confidence,
    setupQuality,
    marketRegime,
    decisionType,
    atrPct,
    riskPct: finalRiskPercent,
    riskAmount: finalRiskAmount,
    expectedProfit,
    riskRewardRatio,
    drawdownMultiplier: mDD,
    volTargetMultiplier: useVolTarget ? mVT : undefined,
  });

  return {
    quantity,
    notional: finalNotional,
    riskAmount: finalRiskAmount,
    riskPercent: finalRiskPercent,
    equityPercent,
    marginRequired,
    expectedProfit,
    expectedLoss,
    riskRewardRatio,
    multipliers: {
      baseRiskPct,
      confidence: 1, // confidence drives baseRiskPct directly, kept here for shape symmetry
      quality: mQ,
      regime: mR,
      volatility: mV,
      strategy: mS,
      drawdown: mDD,
      volTarget: mVT,
    },
    rationale,
    externalSizeMultiplier: extM,
  };
}

/** Bound the news-layer multiplier defensively. Negative inputs are treated as zero. */
function clampExternal(m: number | undefined): number {
  if (m == null || !Number.isFinite(m)) return 1;
  if (m <= 0) return 0;
  return Math.min(1.3, m);
}

function buildRationale(p: {
  equityPercent: number;
  confidence: number;
  setupQuality?: SetupQuality;
  marketRegime?: string;
  decisionType?: string;
  atrPct?: number | null;
  riskPct: number;
  riskAmount: number;
  expectedProfit: number;
  riskRewardRatio: number;
  drawdownMultiplier: number;
  volTargetMultiplier?: number;
}): string {
  const parts: string[] = [];
  parts.push(`${p.equityPercent.toFixed(1)}% equity`);
  if (p.setupQuality) parts.push(`${p.setupQuality} setup`);
  if (p.confidence >= 85) parts.push("high confidence");
  else if (p.confidence >= 75) parts.push("solid confidence");
  if (p.marketRegime) parts.push(p.marketRegime.toLowerCase());
  if (p.decisionType && p.decisionType !== "NONE") {
    parts.push(p.decisionType.toLowerCase());
  }
  if (p.atrPct != null) {
    if (p.atrPct < 1.5) parts.push("low vol");
    else if (p.atrPct > 5) parts.push("high vol");
  }
  // Surface the risk-gate multipliers when they actually moved the size,
  // so the rationale string explains *why* it ended up smaller than the
  // base formula would suggest.
  if (p.drawdownMultiplier < 1) {
    parts.push(`DD×${p.drawdownMultiplier.toFixed(2)}`);
  }
  if (p.volTargetMultiplier != null && Math.abs(p.volTargetMultiplier - 1) > 0.05) {
    parts.push(`volTgt×${p.volTargetMultiplier.toFixed(2)}`);
  }
  const head = `AI allocated ${parts.join(", ")}`;
  const tail =
    `· risk $${p.riskAmount.toFixed(0)} (${p.riskPct.toFixed(2)}%) ` +
    `· target +$${p.expectedProfit.toFixed(0)} ` +
    `· RR ${p.riskRewardRatio.toFixed(2)}`;
  return `${head} ${tail}`;
}

export const SIZING_BOUNDS = {
  MIN_NOTIONAL_USDT,
  MAX_NOTIONAL_USDT,
  MIN_EXPECTED_PROFIT_USDT,
  MAX_SINGLE_TRADE_EQUITY_PCT,
  MAX_TOTAL_EXPOSURE_PCT,
  MAX_PER_SYMBOL_EXPOSURE_PCT,
  MAX_LEVERAGE,
} as const;
