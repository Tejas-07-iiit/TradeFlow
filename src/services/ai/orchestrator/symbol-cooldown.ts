/**
 * Per-symbol AI re-analysis cooldowns.
 *
 * Goal: stop the autonomous scanner from generating a fresh thesis or
 * decision for the same symbol every 5 seconds when nothing material has
 * changed. The token bill the user is seeing is dominated by this kind of
 * redundant churn, not by the actual decisions themselves.
 *
 * Mechanics:
 *   - Track the last successful (thesis | decision) timestamp per
 *     (kind, symbol, timeframe).
 *   - When a new request lands inside the cooldown window AND none of the
 *     invalidation triggers fire, the caller returns the cached result
 *     without calling the LLM.
 *
 * Invalidation triggers (any of these wakes the cooldown immediately):
 *   - Volatility spike: ATR% jumped > 25% relative to the last sample.
 *   - Regime change: marketRegime label differs from the previous read.
 *   - Position state changed: hasOpenPosition flipped or last decision
 *     direction differs.
 *   - Strong news event: caller passes `forceWake: true` (used by the
 *     news subscriber when a high-impact item arrives).
 *
 * Defaults can be overridden via env:
 *   AI_SYMBOL_COOLDOWN_THESIS_MS   (default 20s)
 *   AI_SYMBOL_COOLDOWN_DECISION_MS (default 15s)
 */

export type CooldownKind = "thesis" | "decision";

interface CooldownSnapshot {
  at: number;
  regime?: string;
  atrPct?: number | null;
  hasOpenPosition?: boolean;
}

const lastSeen = new Map<string, CooldownSnapshot>();

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function cooldownMs(kind: CooldownKind): number {
  return kind === "thesis"
    ? intFromEnv("AI_SYMBOL_COOLDOWN_THESIS_MS", 20_000)
    : intFromEnv("AI_SYMBOL_COOLDOWN_DECISION_MS", 15_000);
}

function bucketKey(kind: CooldownKind, symbol: string, timeframe: string): string {
  return `${kind}:${symbol}:${timeframe}`;
}

export interface CooldownCheckInput {
  kind: CooldownKind;
  symbol: string;
  timeframe: string;
  /** Current market regime label (e.g. "Trending Up"). */
  regime?: string;
  /** Current ATR% — used to detect volatility spikes vs prior snapshot. */
  atrPct?: number | null;
  /** Current position state (open/flat). */
  hasOpenPosition?: boolean;
  /** External force-wake — e.g. high-impact news arrived. */
  forceWake?: boolean;
}

export interface CooldownDecision {
  /** True when the cooldown is active and the caller should reuse cache. */
  suppress: boolean;
  /** Milliseconds remaining in the cooldown window when suppressed. */
  remainingMs: number;
  /** Why we did (or did not) suppress — for log lines. */
  reason: string;
}

const VOL_SPIKE_RATIO = 1.25; // 25% jump in ATR% wakes the cooldown.

export function checkCooldown(input: CooldownCheckInput): CooldownDecision {
  const ttl = cooldownMs(input.kind);
  if (ttl === 0) return { suppress: false, remainingMs: 0, reason: "cooldown disabled" };

  const key = bucketKey(input.kind, input.symbol, input.timeframe);
  const prev = lastSeen.get(key);
  if (!prev) return { suppress: false, remainingMs: 0, reason: "first observation" };

  const elapsed = Date.now() - prev.at;
  const remaining = ttl - elapsed;
  if (remaining <= 0) {
    return { suppress: false, remainingMs: 0, reason: "cooldown elapsed" };
  }

  if (input.forceWake) {
    return { suppress: false, remainingMs: 0, reason: "force wake (news)" };
  }
  if (prev.regime && input.regime && prev.regime !== input.regime) {
    return { suppress: false, remainingMs: 0, reason: `regime change (${prev.regime} → ${input.regime})` };
  }
  if (
    prev.hasOpenPosition != null &&
    input.hasOpenPosition != null &&
    prev.hasOpenPosition !== input.hasOpenPosition
  ) {
    return { suppress: false, remainingMs: 0, reason: "position state change" };
  }
  if (
    prev.atrPct != null &&
    input.atrPct != null &&
    prev.atrPct > 0 &&
    input.atrPct / prev.atrPct >= VOL_SPIKE_RATIO
  ) {
    return {
      suppress: false,
      remainingMs: 0,
      reason: `volatility spike (atrPct ${prev.atrPct.toFixed(2)} → ${input.atrPct.toFixed(2)})`,
    };
  }

  return {
    suppress: true,
    remainingMs: remaining,
    reason: `within cooldown window (${Math.round(elapsed / 1000)}s / ${Math.round(ttl / 1000)}s)`,
  };
}

/** Record a successful LLM call so future checks compare against this snapshot. */
export function recordSuccess(input: CooldownCheckInput): void {
  const key = bucketKey(input.kind, input.symbol, input.timeframe);
  lastSeen.set(key, {
    at: Date.now(),
    regime: input.regime,
    atrPct: input.atrPct,
    hasOpenPosition: input.hasOpenPosition,
  });
}

/** Force-clear a single bucket — used when the user manually requests a refresh. */
export function clearCooldown(input: { kind: CooldownKind; symbol: string; timeframe: string }): void {
  lastSeen.delete(bucketKey(input.kind, input.symbol, input.timeframe));
}
