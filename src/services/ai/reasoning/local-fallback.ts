/**
 * Local deterministic decision engine.
 *
 * Produces a `MarketDecision` from the strategy snapshot + indicators
 * without any LLM call. Used as the final link in the decision chain
 * when every LLM provider is rate-limited / cooled-down, so the
 * autonomous executor never freezes.
 *
 * Design principle: be DEFENSIVE. Without the LLM coordinator vetoing
 * conflicts, the local engine should size smaller, accept narrower
 * setups, and refuse anything that smells like a high-risk trade. The
 * goal is to keep paper trading alive in degraded mode, not to outrun
 * the LLM in normal conditions.
 *
 * Decision mapping:
 *
 *   alignmentScore >= 70 + |netDirection| >= 25 → directional trade
 *                                                   (BREAKOUT/PULLBACK/REVERSAL
 *                                                    by regime, or plain BUY/SELL)
 *   alignmentScore  50-69 + |netDirection| >= 15 → conservative BUY/SELL,
 *                                                   smaller size
 *   anything else                                → HOLD
 *
 * Sizing is capped at 25% (LLM path allows up to 50% on A/A+) so a
 * mis-classified local decision can't blow out the book.
 */

import type { DecisionInput, MarketDecision, TradeDecision } from "../schemas";

const STRONG_ALIGNMENT = 70;
const MODERATE_ALIGNMENT = 50;
const STRONG_NET_DIR = 25;
const MODERATE_NET_DIR = 15;

const MAX_LOCAL_SIZE_PCT = 25; // hard cap when LLM isn't supervising

export function localFallbackDecision(input: DecisionInput): MarketDecision {
  const snap = input.strategySnapshot;
  const price = input.price;
  const regime = input.marketRegime;
  const hasOpenPosition = !!input.portfolio?.hasOpenPositionThisSymbol;

  if (!snap) {
    return holdDecision(input, "Local fallback: no strategy snapshot available.");
  }

  // Active position management without an LLM is risky — the LLM is what
  // normally vetoes premature exits. Stay flat and let the executor's
  // hard SL/TP take care of it.
  if (hasOpenPosition) {
    return holdDecision(
      input,
      `Local fallback: open position on ${input.symbol}; deferring management decisions to executor SL/TP.`,
    );
  }

  const align = snap.alignmentScore;
  const netDir = snap.netDirection;
  const absDir = Math.abs(netDir);
  const direction: "long" | "short" | "none" =
    align >= MODERATE_ALIGNMENT && absDir >= MODERATE_NET_DIR
      ? netDir > 0
        ? "long"
        : "short"
      : "none";

  if (direction === "none") {
    return holdDecision(
      input,
      `Local fallback: alignment ${align.toFixed(0)} / netDir ${netDir.toFixed(0)} below action threshold.`,
    );
  }

  const isStrong = align >= STRONG_ALIGNMENT && absDir >= STRONG_NET_DIR;
  const decision = pickDecisionLabel(direction, regime, isStrong);
  const setupQuality = pickSetupQuality(align);
  const riskLevel = pickRiskLevel(snap, regime);
  const positionSizePercent = pickSize(setupQuality, isStrong);

  // Risk geometry. Without LLM-derived levels we synthesize from ATR%
  // when available, else fall back to a fixed pct of price.
  const atrPct = input.indicators.atrPct;
  const slPct =
    atrPct != null && atrPct > 0
      ? Math.min(Math.max(atrPct * 0.6, 0.6), 2.0) / 100
      : 0.012; // 1.2% default
  const tpPct = slPct * 1.8; // RR ≈ 1.8

  const { entryPrice, stopLoss, takeProfit } = computeLevels(
    direction,
    price,
    slPct,
    tpPct,
  );

  const aligned = snap.topStrategies
    .filter((s) => (direction === "long" ? s.signal === "BUY" : s.signal === "SELL"))
    .slice(0, 4)
    .map((s) => s.strategyName);

  const conflicting = snap.conflictingStrategies
    .slice(0, 3)
    .map((s) => s.strategyName);

  const reasoning = buildReasoning(snap, direction, isStrong, aligned, regime);
  const warnings = buildWarnings(snap, conflicting, atrPct);

  return {
    decision,
    confidence: clampInt(Math.round(40 + align * 0.4), 40, 78), // never claim > 78 without LLM
    setupQuality,
    riskLevel,
    executeTrade: true,
    positionSizePercent,
    expectedHoldTimeMinutes: isStrong ? 90 : 45,
    entryPrice,
    takeProfit,
    stopLoss,
    reasoning,
    warnings,
    marketSummary: clampLen(
      `Local fallback (LLM unavailable): ${regime} regime, alignment ${align.toFixed(0)}, netDirection ${netDir.toFixed(0)}. ${direction === "long" ? "Long" : "Short"} bias with ${aligned.length} aligned analyst${aligned.length === 1 ? "" : "s"}.`,
      20,
      300,
    ),
    alignedStrategies: aligned,
    conflictingStrategies: conflicting,
    marketConditions: clampLen(
      `${regime}; alignment ${align.toFixed(0)}/100`,
      10,
      240,
    ),
    executionRecommendation: isStrong
      ? "execute immediately"
      : "wait for confirmation",
  };
}

function holdDecision(input: DecisionInput, reason: string): MarketDecision {
  return {
    decision: "HOLD",
    confidence: 35,
    setupQuality: "C",
    riskLevel: "Low",
    executeTrade: false,
    positionSizePercent: 0,
    expectedHoldTimeMinutes: 5,
    entryPrice: input.price,
    takeProfit: input.price,
    stopLoss: input.price,
    reasoning: [clampLen(reason, 5, 200)],
    warnings: [],
    marketSummary: clampLen(
      `${input.marketRegime} regime; local fallback returned HOLD because LLM coordination is unavailable and conditions do not meet the deterministic trade threshold.`,
      20,
      300,
    ),
    alignedStrategies: [],
    conflictingStrategies: [],
    marketConditions: clampLen(
      `${input.marketRegime}; degraded mode`,
      10,
      240,
    ),
    executionRecommendation: "skip",
  };
}

function pickDecisionLabel(
  direction: "long" | "short",
  regime: string,
  isStrong: boolean,
): TradeDecision {
  const r = regime.toLowerCase();
  if (direction === "long") {
    if (!isStrong) return "BUY";
    if (r.includes("trending up") || r.includes("breakout")) return "BREAKOUT LONG";
    if (r.includes("reversal")) return "REVERSAL LONG";
    if (r.includes("trending")) return "PULLBACK LONG";
    return "BUY";
  }
  if (!isStrong) return "SELL";
  if (r.includes("trending down") || r.includes("breakdown")) return "BREAKDOWN SHORT";
  return "SELL";
}

function pickSetupQuality(align: number): MarketDecision["setupQuality"] {
  if (align >= 80) return "A";
  if (align >= 65) return "B+";
  if (align >= 50) return "B";
  return "C";
}

function pickRiskLevel(
  snap: NonNullable<DecisionInput["strategySnapshot"]>,
  regime: string,
): MarketDecision["riskLevel"] {
  const r = regime.toLowerCase();
  if (r.includes("high volatility") || snap.aggregateVolatilityScore > 70) {
    return "High";
  }
  if (snap.aggregateVolatilityScore < 35 && snap.alignmentScore >= 70) {
    return "Low";
  }
  return "Medium";
}

function pickSize(
  setupQuality: MarketDecision["setupQuality"],
  isStrong: boolean,
): number {
  // Caps below the LLM path. The LLM gets to size up to 50% on A/A+;
  // the local engine never goes above 25% because it can't reason
  // about edge cases.
  if (setupQuality === "A" || setupQuality === "A+") {
    return isStrong ? MAX_LOCAL_SIZE_PCT : 20;
  }
  if (setupQuality === "B+") return 15;
  if (setupQuality === "B") return 10;
  return 0;
}

function computeLevels(
  direction: "long" | "short",
  price: number,
  slPct: number,
  tpPct: number,
): { entryPrice: number; stopLoss: number; takeProfit: number } {
  const entryPrice = price;
  if (direction === "long") {
    return {
      entryPrice,
      stopLoss: round(price * (1 - slPct), price),
      takeProfit: round(price * (1 + tpPct), price),
    };
  }
  return {
    entryPrice,
    stopLoss: round(price * (1 + slPct), price),
    takeProfit: round(price * (1 - tpPct), price),
  };
}

function buildReasoning(
  snap: NonNullable<DecisionInput["strategySnapshot"]>,
  direction: "long" | "short",
  isStrong: boolean,
  aligned: string[],
  regime: string,
): string[] {
  const out: string[] = [];
  out.push(
    clampLen(
      `Local fallback engine selected ${direction === "long" ? "LONG" : "SHORT"} bias from snapshot: alignment ${snap.alignmentScore.toFixed(0)}, netDirection ${snap.netDirection.toFixed(0)}, regime ${regime}.`,
      5,
      200,
    ),
  );
  if (aligned.length > 0) {
    out.push(
      clampLen(
        `Aligned analysts: ${aligned.slice(0, 3).join(", ")}.`,
        5,
        200,
      ),
    );
  }
  if (isStrong) {
    out.push(
      clampLen(
        `Strong alignment + directional edge — local engine cleared this for execution despite LLM unavailability.`,
        5,
        200,
      ),
    );
  } else {
    out.push(
      clampLen(
        `Moderate alignment — sized conservatively (LLM coordinator offline, no premium reasoning to expand size).`,
        5,
        200,
      ),
    );
  }
  return out.slice(0, 4);
}

function buildWarnings(
  snap: NonNullable<DecisionInput["strategySnapshot"]>,
  conflicting: string[],
  atrPct: number | null,
): string[] {
  const out: string[] = [];
  out.push(
    clampLen(
      `Decision generated without LLM coordinator — degraded mode; expect reduced setup quality vs normal operation.`,
      3,
      200,
    ),
  );
  if (conflicting.length > 0) {
    out.push(
      clampLen(
        `Conflicting strategies present: ${conflicting.slice(0, 2).join(", ")}. LLM would normally arbitrate; local engine proceeds on snapshot alignment.`,
        3,
        200,
      ),
    );
  }
  if (atrPct != null && atrPct > 3.5) {
    out.push(
      clampLen(
        `ATR% elevated (${atrPct.toFixed(2)}%) — wider noise band; tighten SL manually if volatility spikes.`,
        3,
        200,
      ),
    );
  }
  return out.slice(0, 3);
}

function round(value: number, reference: number): number {
  // Match precision to price magnitude — BTC trades at 60K so 2 decimals
  // is fine; an altcoin at 0.05 needs 6. Use the reference's order of
  // magnitude to pick.
  const mag = Math.log10(Math.max(reference, 1e-9));
  const decimals = Math.max(2, 6 - Math.floor(mag));
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function clampInt(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(value)));
}

function clampLen(s: string, min: number, max: number): string {
  if (s.length > max) return s.slice(0, max - 1) + "…";
  if (s.length < min) return s.padEnd(min, ".");
  return s;
}
