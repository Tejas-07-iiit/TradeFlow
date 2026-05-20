import type { PatternCategory } from "./types";

/**
 * Direction-neutral classification for every TA-Lib CDL pattern this engine
 * supports. The taxonomy here drives:
 *   - regime weighting (reversal weak in trend, continuation weak in chop)
 *   - LLM prompt formatting (grouped by family)
 *   - chart overlay colouring
 *
 * Reliability prior is a 0..1 anchor used by the confidence engine as the
 * starting score. Numbers reflect well-documented empirical priors — single-
 * bar dojis and spinning tops are weak; engulfings, morning/evening stars,
 * three-soldiers/crows are strong; obscure 4-bar patterns sit in the middle.
 */
export const PATTERN_TAXONOMY: Record<
  string,
  { name: string; category: PatternCategory; reliability: number; lookback: number }
> = {
  // ─── Single-bar ─────────────────────────────────────────────────────────
  CDLDOJI: { name: "Doji", category: "Indecision", reliability: 0.45, lookback: 11 },
  CDLDOJISTAR: { name: "Doji Star", category: "Bullish Reversal", reliability: 0.6, lookback: 12 },
  CDLDRAGONFLYDOJI: { name: "Dragonfly Doji", category: "Bullish Reversal", reliability: 0.6, lookback: 11 },
  CDLGRAVESTONEDOJI: { name: "Gravestone Doji", category: "Bearish Reversal", reliability: 0.6, lookback: 11 },
  CDLLONGLEGGEDDOJI: { name: "Long-Legged Doji", category: "Indecision", reliability: 0.45, lookback: 11 },
  CDLRICKSHAWMAN: { name: "Rickshaw Man", category: "Indecision", reliability: 0.4, lookback: 11 },
  CDLHAMMER: { name: "Hammer", category: "Bullish Reversal", reliability: 0.7, lookback: 11 },
  CDLINVERTEDHAMMER: { name: "Inverted Hammer", category: "Bullish Reversal", reliability: 0.55, lookback: 11 },
  CDLHANGINGMAN: { name: "Hanging Man", category: "Bearish Reversal", reliability: 0.65, lookback: 11 },
  CDLSHOOTINGSTAR: { name: "Shooting Star", category: "Bearish Reversal", reliability: 0.7, lookback: 11 },
  CDLTAKURI: { name: "Takuri (Dragonfly variant)", category: "Bullish Reversal", reliability: 0.55, lookback: 11 },
  CDLMARUBOZU: { name: "Marubozu", category: "Momentum", reliability: 0.7, lookback: 11 },
  CDLCLOSINGMARUBOZU: { name: "Closing Marubozu", category: "Momentum", reliability: 0.65, lookback: 11 },
  CDLLONGLINE: { name: "Long Line", category: "Momentum", reliability: 0.55, lookback: 11 },
  CDLSHORTLINE: { name: "Short Line", category: "Indecision", reliability: 0.4, lookback: 11 },
  CDLSPINNINGTOP: { name: "Spinning Top", category: "Indecision", reliability: 0.4, lookback: 11 },
  CDLHIGHWAVE: { name: "High Wave", category: "Indecision", reliability: 0.45, lookback: 11 },
  CDLBELTHOLD: { name: "Belt Hold", category: "Momentum", reliability: 0.55, lookback: 11 },

  // ─── Two-bar ────────────────────────────────────────────────────────────
  CDLENGULFING: { name: "Engulfing", category: "Bullish Reversal", reliability: 0.78, lookback: 12 },
  CDLHARAMI: { name: "Harami", category: "Bullish Reversal", reliability: 0.6, lookback: 12 },
  CDLHARAMICROSS: { name: "Harami Cross", category: "Bullish Reversal", reliability: 0.68, lookback: 12 },
  CDLPIERCING: { name: "Piercing Pattern", category: "Bullish Reversal", reliability: 0.7, lookback: 12 },
  CDLDARKCLOUDCOVER: { name: "Dark Cloud Cover", category: "Bearish Reversal", reliability: 0.7, lookback: 12 },
  CDLCOUNTERATTACK: { name: "Counterattack", category: "Bullish Reversal", reliability: 0.55, lookback: 12 },
  CDLHOMINGPIGEON: { name: "Homing Pigeon", category: "Bullish Reversal", reliability: 0.55, lookback: 12 },
  CDLINNECK: { name: "In-Neck", category: "Continuation", reliability: 0.45, lookback: 12 },
  CDLONNECK: { name: "On-Neck", category: "Continuation", reliability: 0.5, lookback: 12 },
  CDLTHRUSTING: { name: "Thrusting", category: "Continuation", reliability: 0.5, lookback: 12 },
  CDLKICKING: { name: "Kicking", category: "Momentum", reliability: 0.75, lookback: 12 },
  CDLKICKINGBYLENGTH: { name: "Kicking by Length", category: "Momentum", reliability: 0.75, lookback: 12 },
  CDLMATCHINGLOW: { name: "Matching Low", category: "Bullish Reversal", reliability: 0.55, lookback: 12 },
  CDLSEPARATINGLINES: { name: "Separating Lines", category: "Continuation", reliability: 0.55, lookback: 12 },

  // ─── Three-bar ──────────────────────────────────────────────────────────
  CDLMORNINGSTAR: { name: "Morning Star", category: "Bullish Reversal", reliability: 0.85, lookback: 13 },
  CDLMORNINGDOJISTAR: { name: "Morning Doji Star", category: "Bullish Reversal", reliability: 0.85, lookback: 13 },
  CDLEVENINGSTAR: { name: "Evening Star", category: "Bearish Reversal", reliability: 0.85, lookback: 13 },
  CDLEVENINGDOJISTAR: { name: "Evening Doji Star", category: "Bearish Reversal", reliability: 0.85, lookback: 13 },
  CDL3WHITESOLDIERS: { name: "Three White Soldiers", category: "Bullish Reversal", reliability: 0.82, lookback: 13 },
  CDL3BLACKCROWS: { name: "Three Black Crows", category: "Bearish Reversal", reliability: 0.82, lookback: 13 },
  CDL3INSIDE: { name: "Three Inside Up/Down", category: "Bullish Reversal", reliability: 0.7, lookback: 13 },
  CDL3OUTSIDE: { name: "Three Outside Up/Down", category: "Bullish Reversal", reliability: 0.72, lookback: 13 },
  CDL3LINESTRIKE: { name: "Three-Line Strike", category: "Continuation", reliability: 0.75, lookback: 14 },
  CDLTRISTAR: { name: "Tristar", category: "Bullish Reversal", reliability: 0.65, lookback: 13 },
  CDL2CROWS: { name: "Two Crows", category: "Bearish Reversal", reliability: 0.65, lookback: 13 },
  CDLUPSIDEGAP2CROWS: { name: "Upside Gap Two Crows", category: "Bearish Reversal", reliability: 0.65, lookback: 13 },
  CDLABANDONEDBABY: { name: "Abandoned Baby", category: "Bullish Reversal", reliability: 0.78, lookback: 13 },
  CDLADVANCEBLOCK: { name: "Advance Block", category: "Exhaustion", reliability: 0.6, lookback: 13 },
  CDLSTALLEDPATTERN: { name: "Stalled Pattern", category: "Exhaustion", reliability: 0.6, lookback: 13 },
  CDLIDENTICAL3CROWS: { name: "Identical Three Crows", category: "Bearish Reversal", reliability: 0.7, lookback: 13 },
  CDL3STARSINSOUTH: { name: "Three Stars in the South", category: "Bullish Reversal", reliability: 0.6, lookback: 13 },
  CDLSTICKSANDWICH: { name: "Stick Sandwich", category: "Bullish Reversal", reliability: 0.55, lookback: 13 },
  CDLTASUKIGAP: { name: "Tasuki Gap", category: "Continuation", reliability: 0.6, lookback: 13 },
  CDLGAPSIDESIDEWHITE: { name: "Side-by-Side White Lines", category: "Continuation", reliability: 0.55, lookback: 13 },
  CDLUNIQUE3RIVER: { name: "Unique Three River Bottom", category: "Bullish Reversal", reliability: 0.55, lookback: 13 },

  // ─── Multi-bar (4+ bars) ────────────────────────────────────────────────
  CDLHIKKAKE: { name: "Hikkake", category: "Breakout Confirmation", reliability: 0.55, lookback: 14 },
  CDLHIKKAKEMOD: { name: "Modified Hikkake", category: "Breakout Confirmation", reliability: 0.6, lookback: 16 },
  CDLMATHOLD: { name: "Mat Hold", category: "Continuation", reliability: 0.7, lookback: 15 },
  CDLRISEFALL3METHODS: { name: "Rising/Falling Three Methods", category: "Continuation", reliability: 0.7, lookback: 15 },
  CDLXSIDEGAP3METHODS: { name: "Upside/Downside Gap Three Methods", category: "Continuation", reliability: 0.6, lookback: 13 },
  CDLCONCEALBABYSWALL: { name: "Concealing Baby Swallow", category: "Bullish Reversal", reliability: 0.6, lookback: 14 },
  CDLLADDERBOTTOM: { name: "Ladder Bottom", category: "Bullish Reversal", reliability: 0.6, lookback: 15 },
  CDLBREAKAWAY: { name: "Breakaway", category: "Bullish Reversal", reliability: 0.6, lookback: 15 },
};

export const PATTERN_IDS = Object.keys(PATTERN_TAXONOMY);
