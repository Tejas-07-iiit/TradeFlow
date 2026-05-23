/**
 * Volatility-targeted sizing multiplier.
 *
 * The institutional sizing principle: keep *expected daily P&L volatility*
 * roughly constant by sizing inversely to forecast volatility. When the
 * tape is calm, size up; when it's wild, size down. The discrete ATR
 * buckets the legacy `position-sizing.volatilityMultiplier` uses approximate
 * this — they get the direction right but not the magnitude. The proper
 * formulation is a continuous ratio:
 *
 *   multiplier = clamp(targetDailyVol / forecastDailyVol, lo, hi)
 *
 * Inputs are vol *expressed as a fraction of price* (e.g. 0.015 = 1.5%
 * daily move). The function is unit-agnostic — the caller just has to use
 * the same units on both sides of the ratio.
 *
 * Bounds default to [0.25, 1.5]: never less than a quarter size (we still
 * want statistical exposure at high vol), never more than 1.5× (vol-target
 * is a sizing scalar, not a leverage cheat code — the position-sizing
 * engine still applies the per-trade and per-symbol equity caps on top).
 *
 * Sensible defaults for crypto on 5m bars:
 *   targetDailyVol = 0.015  (i.e. target ~1.5% daily P&L vol on the trade)
 *   forecastDailyVol = realized vol from the indicator context (already
 *                      computed as `realizedVol` in IndicatorContext).
 *
 * When forecast is missing or non-positive, returns multiplier=1 so the
 * caller gets the legacy discrete-bucket behavior — no harm, no regression.
 */

export interface VolTargetInput {
  /** Target daily P&L volatility as a fraction (e.g. 0.015 = 1.5%). */
  targetDailyVol: number;
  /** Forecast daily volatility as a fraction. Typically realized vol from
   *  the strategy snapshot's IndicatorContext. */
  forecastDailyVol: number | null | undefined;
  /** Optional floor. Default 0.25 — never scale below quarter-size. */
  floor?: number;
  /** Optional ceiling. Default 1.5 — never scale above 1.5×. */
  ceiling?: number;
}

export interface VolTargetResult {
  multiplier: number;
  /** Raw ratio before clamping — useful for telemetry. */
  rawRatio: number;
  /** True when the forecast was missing/invalid and we fell back to 1.0. */
  fellBack: boolean;
  reason: string;
}

export function computeVolTargetMultiplier(input: VolTargetInput): VolTargetResult {
  const target = input.targetDailyVol;
  const forecast = input.forecastDailyVol;
  const floor = input.floor ?? 0.25;
  const ceiling = input.ceiling ?? 1.5;

  if (!Number.isFinite(target) || target <= 0) {
    return {
      multiplier: 1,
      rawRatio: 1,
      fellBack: true,
      reason: "vol-target inactive (invalid target)",
    };
  }
  if (forecast == null || !Number.isFinite(forecast) || forecast <= 0) {
    return {
      multiplier: 1,
      rawRatio: 1,
      fellBack: true,
      reason: "vol-target inactive (forecast unavailable; using discrete fallback)",
    };
  }

  const raw = target / forecast;
  const clamped = Math.max(floor, Math.min(ceiling, raw));
  const adj = raw < floor ? "floor" : raw > ceiling ? "ceiling" : "raw";

  return {
    multiplier: clamped,
    rawRatio: raw,
    fellBack: false,
    reason:
      `vol-target ${clamped.toFixed(2)}× ` +
      `(target ${(target * 100).toFixed(2)}% / forecast ${(forecast * 100).toFixed(2)}%, ${adj})`,
  };
}
