import { lastValue, supertrend } from "@/lib/indicators/calculations";
import type { Candle } from "@/types/market";

/**
 * Shared helper for HyperSupertrend + BEST Supertrend.
 *
 * Three Supertrend configurations covering fast/medium/slow sensitivity so a
 * single market read provides a consensus instead of a single noisy line.
 * Both strategies call this once per tick — the cost of three Supertrend
 * runs is negligible compared with even a single Groq round-trip.
 */
const CONFIGS: ReadonlyArray<{ period: number; multiplier: number; label: string }> = [
  { period: 10, multiplier: 1, label: "ST(10,1)" },
  { period: 11, multiplier: 2, label: "ST(11,2)" },
  { period: 12, multiplier: 3, label: "ST(12,3)" },
];

export interface SupertrendVote {
  label: string;
  trend: 1 | -1;
  value: number;
}

export function supertrendTrio(candles: Candle[]): SupertrendVote[] {
  const out: SupertrendVote[] = [];
  for (const cfg of CONFIGS) {
    const series = supertrend(candles, cfg.period, cfg.multiplier);
    const last = lastValue(series);
    if (!last) continue;
    out.push({ label: cfg.label, trend: last.trend, value: last.value });
  }
  return out;
}

export function countDirection(votes: SupertrendVote[], dir: 1 | -1): number {
  return votes.filter((v) => v.trend === dir).length;
}
