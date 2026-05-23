/**
 * Drawdown-aware size scaling.
 *
 * The gate maps current equity (relative to a high-water mark) to a
 * multiplier the position-sizing engine applies to candidate size. It's the
 * mechanical equivalent of "trade smaller when you're down" — but mechanical
 * specifically because discretionary risk reduction in a drawdown is what
 * blows the account up. The schedule is intentionally aggressive at the
 * deep end because the empirical recovery cost of a deeper drawdown is
 * non-linear: at -20% you need +25% just to get whole.
 *
 * Schedule (cumulative drawdown from peak):
 *   <  5% : 1.00 — normal sizing
 *   <  8% : 0.85 — slight tilt down, recovery-mode
 *   < 12% : 0.65 — meaningful reduction
 *   < 16% : 0.40 — preservation mode
 *   < 20% : 0.20 — only the best setups
 *   >=20% : 0.00 — halt new entries; manage open only
 *
 * The 5% / 8% / 12% / 16% / 20% breakpoints reflect what a 60k paper
 * account typically tolerates before behavioural pressure pushes a human
 * to revenge-trade. The kill-switch at 20% is non-negotiable — the system
 * must opt out and require manual restart, not silently keep risking.
 *
 * `peakEquity` is the caller's responsibility. Without a stored high-water
 * mark, pass `max(currentEquity, accountStartingBalance)` so the gate
 * activates as soon as the account dips below its starting cash — which
 * is the right behaviour for paper trading where the start = the original
 * benchmark.
 */

export type DrawdownBucket = "normal" | "tilt" | "reduce" | "preserve" | "minimal" | "halt";

export interface DrawdownGateInput {
  currentEquity: number;
  peakEquity: number;
}

export interface DrawdownGateResult {
  multiplier: number;
  drawdownPct: number;
  bucket: DrawdownBucket;
  /** True when the gate fully halts new entries (size = 0). */
  haltNewEntries: boolean;
  reason: string;
}

export function computeDrawdownMultiplier(input: DrawdownGateInput): DrawdownGateResult {
  const { currentEquity, peakEquity } = input;

  if (!Number.isFinite(currentEquity) || !Number.isFinite(peakEquity) || peakEquity <= 0) {
    return {
      multiplier: 1,
      drawdownPct: 0,
      bucket: "normal",
      haltNewEntries: false,
      reason: "drawdown gate inactive (invalid equity inputs)",
    };
  }

  // Equity above peak — sometimes happens between settlement cycles. Treat
  // as normal sizing rather than amplifying.
  if (currentEquity >= peakEquity) {
    return {
      multiplier: 1,
      drawdownPct: 0,
      bucket: "normal",
      haltNewEntries: false,
      reason: "at or above peak equity",
    };
  }

  const ddPct = ((peakEquity - currentEquity) / peakEquity) * 100;

  if (ddPct < 5) {
    return {
      multiplier: 1,
      drawdownPct: ddPct,
      bucket: "normal",
      haltNewEntries: false,
      reason: `DD ${ddPct.toFixed(2)}% — normal sizing`,
    };
  }
  if (ddPct < 8) {
    return {
      multiplier: 0.85,
      drawdownPct: ddPct,
      bucket: "tilt",
      haltNewEntries: false,
      reason: `DD ${ddPct.toFixed(2)}% — slight tilt down (×0.85)`,
    };
  }
  if (ddPct < 12) {
    return {
      multiplier: 0.65,
      drawdownPct: ddPct,
      bucket: "reduce",
      haltNewEntries: false,
      reason: `DD ${ddPct.toFixed(2)}% — recovery mode (×0.65)`,
    };
  }
  if (ddPct < 16) {
    return {
      multiplier: 0.4,
      drawdownPct: ddPct,
      bucket: "preserve",
      haltNewEntries: false,
      reason: `DD ${ddPct.toFixed(2)}% — preservation mode (×0.40)`,
    };
  }
  if (ddPct < 20) {
    return {
      multiplier: 0.2,
      drawdownPct: ddPct,
      bucket: "minimal",
      haltNewEntries: false,
      reason: `DD ${ddPct.toFixed(2)}% — minimal sizing, A-grade only (×0.20)`,
    };
  }
  return {
    multiplier: 0,
    drawdownPct: ddPct,
    bucket: "halt",
    haltNewEntries: true,
    reason: `DD ${ddPct.toFixed(2)}% ≥ 20% — kill switch engaged; new entries halted`,
  };
}
