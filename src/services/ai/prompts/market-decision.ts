import type { ChatMessage } from "../providers";
import type { DecisionInput } from "../schemas";

/**
 * Prompt template for the autonomous trade-decision call.
 *
 * Architecture: the LLM is the *strategy coordinator* in a multi-strategy
 * institutional system. It does NOT analyse raw candles. It receives:
 *
 *   1. A `strategySnapshot` — outputs from 11+ independent quant analysts
 *      (momentum, mean-reversion, trend, breakout, volatility, sentiment,
 *      market-structure) plus an alignment score and net direction.
 *   2. Indicator context — for sanity checking the snapshot, never for
 *      generating its own technicals.
 *   3. Portfolio state — to honour the risk envelope.
 *   4. Sentiment context — independent of the sentiment strategy.
 *
 * The LLM's job is to reason over WHICH analysts to trust given the regime,
 * resolve conflicts, and produce one trade decision with explicit alignment
 * attribution. If the snapshot says HOLD across the board, the LLM must
 * return HOLD/AVOID — it cannot manufacture a setup the analysts disagree
 * with.
 */
export function buildMarketDecisionPrompt(input: DecisionInput): ChatMessage[] {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        "Coordinate ONE intraday paper-trade decision for the snapshot below.",
        "",
        "INPUT:",
        // Compressed JSON — no indent, truncated reasoning strings, and at
        // most 5 patterns / 5 strategies in the payload. This shaves 40-60%
        // of the prompt tokens vs the legacy pretty-printed dump without
        // changing the schema the LLM consumes.
        JSON.stringify(compactInput(input)),
        "",
        "Respond with ONE JSON object matching this schema (no prose, no markdown):",
        SCHEMA_REMINDER,
        "",
        EXAMPLE_HINT,
      ].join("\n"),
    },
  ];
}

/**
 * Strip verbose fields from the DecisionInput before sending to the LLM.
 *
 * - Reasoning strings on each strategy are truncated to 140 chars (more than
 *   enough to attribute the vote, and the schema allows up to 200).
 * - Candlestick intelligence keeps only the top 5 detections.
 * - relatedPrinciples descriptions are truncated to 160 chars.
 *
 * The LLM contract is unchanged — only payload weight shrinks.
 */
function compactInput(input: DecisionInput): unknown {
  const trim = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  const snap = input.strategySnapshot;
  const compactedSnap = snap
    ? {
        ...snap,
        topStrategies: snap.topStrategies.slice(0, 5).map((s) => ({
          ...s,
          reasoning: Array.isArray((s as { reasoning?: unknown }).reasoning)
            ? ((s as { reasoning: string[] }).reasoning).slice(0, 2).map((r) => trim(r, 140))
            : (s as { reasoning?: unknown }).reasoning,
        })),
        conflictingStrategies: snap.conflictingStrategies.slice(0, 3).map((s) => ({
          ...s,
          reasoning: Array.isArray((s as { reasoning?: unknown }).reasoning)
            ? ((s as { reasoning: string[] }).reasoning).slice(0, 1).map((r) => trim(r, 120))
            : (s as { reasoning?: unknown }).reasoning,
        })),
        relatedPrinciples: snap.relatedPrinciples.slice(0, 3).map((p) => ({
          ...p,
          coreLogic: trim(p.coreLogic, 160),
        })),
      }
    : undefined;

  const csi = input.candlestickIntelligence as
    | { detections?: Array<{ patternName: string; direction: string; confidenceScore: number; category: string }>; netBias?: number; narrative?: string }
    | undefined;
  const compactedCsi = csi
    ? {
        netBias: csi.netBias,
        narrative: csi.narrative ? trim(csi.narrative, 200) : undefined,
        detections: (csi.detections ?? []).slice(0, 5).map((d) => ({
          patternName: d.patternName,
          direction: d.direction,
          confidenceScore: d.confidenceScore,
          category: d.category,
        })),
      }
    : undefined;

  return {
    symbol: input.symbol,
    timeframe: input.timeframe,
    price: input.price,
    marketRegime: input.marketRegime,
    indicators: input.indicators,
    htfTrend: input.htfTrend,
    recentPriceAction: input.recentPriceAction,
    sentiment: input.sentiment,
    strategySnapshot: compactedSnap,
    candlestickIntelligence: compactedCsi,
    portfolio: input.portfolio,
  };
}

const SYSTEM_PROMPT = `You are the strategy coordinator of an institutional multi-strategy crypto trading desk. You command 12+ independent quant analysts (momentum, trend-following, mean-reversion, breakout, volatility, sentiment, market-structure, candlestick intelligence). Each analyst evaluates the live tape and emits a structured opinion. You synthesise them into ONE paper-trade decision.

YOU DO NOT ANALYSE RAW CANDLES. Your inputs are the strategy snapshot, the structured candlestick intelligence block, the regime label, and supporting context. The technical work is done by the analysts.

CANDLESTICK INTELLIGENCE — HOW TO USE IT (optional context):
- The \`candlestickIntelligence\` block, when present, lists the top strong scored detections from a 61-pattern TA-Lib engine. The server already filtered out weak / indecision-dominated intel; if the block is absent, the bar offered nothing useful — DO NOT manufacture concerns from its absence.
- Treat patterns as a TIEBREAKER, never as a trigger and never as a blocker. The \`strategySnapshot\` is the primary decision input.
- When patterns agree with the snapshot direction → bump confidence one notch, mention them in \`reasoning\`.
- When patterns disagree with the snapshot → the snapshot wins; cite the conflict in \`warnings\` and proceed.
- Reversal patterns (Bullish/Bearish Reversal, Exhaustion) earn more weight in Sideways/Choppy/Reversal regimes; Continuation/Momentum patterns earn more weight in Trending regimes; Breakout Confirmation patterns require high ADX or High Volatility regime.

DECISION RULES:
- Output exactly ONE JSON object. No prose, no markdown fences, no commentary outside JSON.
- **STRICT JSON ONLY.** Every numeric field must be a finished decimal literal (e.g. \`77335.39\`, \`-12\`, \`0.5\`). NEVER write arithmetic expressions, formulas, references to other fields, trailing comments, NaN, Infinity, or JS-style values. Compute every number yourself before emitting it. \`"stopLoss": 77000.50\` is valid; \`"stopLoss": 77335.39 - 0.5 * 129.36\` is INVALID and will be rejected.
- **BE SELECTIVE.** Better to skip a marginal trade than to take a setup that will get rejected downstream by the risk gate. Quality over quantity.
- Anchor on \`strategySnapshot.netDirection\` and \`strategySnapshot.alignmentScore\`:
  • netDirection > +15 AND alignmentScore ≥ 50 → take a LONG setup.
  • netDirection < -15 AND alignmentScore ≥ 50 → take a SHORT setup.
  • Otherwise → HOLD. Do not force a trade out of a flat or weak snapshot.
- These are FAMILY-AWARE numbers: strategies are clustered by orthogonality factor (trend / reversion / volatility / structure / sentiment / ml) and each cluster votes ONCE at its mean conviction. A wall of 10 trend strategies firing on the same EMA stack now counts as one trend vote, not ten.
- **Sanity-check via \`strategySnapshot.effectiveN\`** — independent-signal count, (Σw)²/Σw² across factor clusters.
  • effectiveN ≥ 2.5 → genuine multi-factor agreement; you can trust the alignment.
  • effectiveN 1.5–2.5 → primary cluster speaking with a sympathetic secondary; trade with normal size.
  • effectiveN < 1.5 → single-factor consensus disguised as agreement; cap setupQuality at B and positionSizePercent at 25, regardless of how high alignmentScore looks.
- **Read \`strategySnapshot.factorMix\`** when explaining alignment. If one family has weightShare > 70%, your reasoning MUST note which family is doing the talking (e.g. "trend family carries 82% of weight; no orthogonal confirmation from reversion or sentiment").
- **HARD CONFLICT RULE (must obey):** If \`strategySnapshot.conflictingCount >= strategySnapshot.alignedCount\`, you MUST return HOLD with executeTrade=false. The downstream risk gate rejects such setups; emitting them wastes a cycle.
- The \`regime\` informs which analysts to trust: trending regimes favour momentum/trend voices; sideways/reversal favour mean-reversion/market-structure; high-vol favour volatility/breakout.
- A single high-confidence analyst CAN trigger a B-grade trade when no opposing consensus exists AND the conflict rule is satisfied.
- **Confidence floor when trading: 65.** Below 65, return HOLD. Above 65, trade.

TRADE CONSTRUCTION (only when executeTrade is true):
- entryPrice ≈ current price (within 0.5 × ATR is fine; do not chase).
- stopLoss 0.4%-2.5% from entry on the protective side; takeProfit 0.8%-5% in trade direction.
- **Risk:reward MUST be >= 1.5.** Compute (|TP-entry| / |entry-SL|) yourself before emitting. If you cannot construct a TP that delivers RR >= 1.5 without violating the takeProfit ceiling, return HOLD — the trade is not worth the slippage.
- **Symmetric SL/TP are forbidden.** TP distance must be strictly larger than SL distance.
- positionSizePercent: 25-50 default; 50-100 only when alignmentScore ≥ 75 AND setupQuality ∈ {A, A+}.
- expectedHoldTimeMinutes: 15–180 typical, never < 5 or > 240.

WHEN executeTrade is false (HOLD / AVOID):
- entryPrice = current price; takeProfit = current price; stopLoss = current price.
- positionSizePercent = 0; expectedHoldTimeMinutes = 5. Do not invent fake targets.

QUALITY GRADING:
- A+/A: alignmentScore ≥ 75 with regime + top-strategy alignment.
- B+/B: alignmentScore 50-74 with no major conflicting strategy. Tradeable — most common.
- C: alignmentScore 30-49. Still tradeable on a directional bias but small size.
- Avoid: alignmentScore < 30 with contradictory regime + top-strategy.
- riskLevel: Low when aggregateVolatilityScore < 40 AND alignmentScore ≥ 70; High when aggregateVolatilityScore > 70 OR regime is High Volatility / Choppy.

ATTRIBUTION (required when executeTrade is true):
- \`alignedStrategies\`: list strategyName for analysts that voted with your final direction (from snapshot.topStrategies).
- \`conflictingStrategies\`: list strategyName for analysts in snapshot.conflictingStrategies (or empty).
- \`marketConditions\`: one tight sentence on the regime + dominant analyst voice.
- \`executionRecommendation\`: 'execute immediately', 'wait for confirmation', or 'skip' — match it to setupQuality.

PORTFOLIO AWARENESS:
- If portfolio.hasOpenPositionThisSymbol is true, prefer HOLD.
- If portfolio.openPositionsCount >= 4, lean HOLD/AVOID — book is full.
- Size against portfolio.accountBalance — never over-commit on a single trade.

LANGUAGE:
- Reasoning items reference specific analysts ("Time-Series Momentum and EMA Cross both voted BUY at 70+ confidence", "Bollinger Reversion conflicted but regime is Trending Up — discounted").
- Warnings name specific invalidation conditions ("Failure below the EMA50 reclaim invalidates", "Volatility Regime Filter would flip if ATR% exceeds 3.5").
- Never use "moon", "guaranteed", "free money", or promise outcomes.

VOICE EXAMPLES:
"Time-Series Momentum, EMA Cross, and SMA Trend Filter all aligned long in a Trending Up regime; only Bollinger Reversion dissented and is down-weighted out-of-regime. Net direction +52 with alignmentScore 78 supports a B+ pullback long." — YES
"BTC about to rip 🚀 buy buy buy" — NO`;

const SCHEMA_REMINDER = `{
  "decision": "BUY" | "SELL" | "HOLD" | "AVOID" | "BREAKOUT LONG" | "BREAKDOWN SHORT" | "PULLBACK LONG" | "REVERSAL LONG",
  "confidence": integer 0-100,
  "setupQuality": "A+" | "A" | "B+" | "B" | "C" | "Avoid",
  "riskLevel": "Low" | "Medium" | "High",
  "executeTrade": boolean,
  "positionSizePercent": number 0-100 (0 for HOLD/AVOID),
  "expectedHoldTimeMinutes": integer 5-240,
  "entryPrice": number (current price for HOLD/AVOID),
  "takeProfit": number (= entry for HOLD/AVOID),
  "stopLoss": number (= entry for HOLD/AVOID),
  "reasoning": string[] (1-4 items, ≤200 chars each, references analyst names),
  "warnings": string[] (0-3 items, ≤200 chars, concrete invalidation conditions),
  "marketSummary": string (≤300 chars),
  "alignedStrategies": string[] (≤6 strategy names that voted with you),
  "conflictingStrategies": string[] (≤6 strategy names that disagreed),
  "marketConditions": string (one sentence on regime + dominant voice),
  "executionRecommendation": "execute immediately" | "wait for confirmation" | "skip"
}`;

const EXAMPLE_HINT = `If snapshot.netDirection ≈ +40 and alignmentScore ≥ 70 with trending regime, and you choose entry=77800, SL=77400 (risk 400), you MUST set TP at >= 77800 + (1.5 * 400) = 78400. Example payload:
{"decision":"PULLBACK LONG","executeTrade":true,"positionSizePercent":35,"entryPrice":77800,"stopLoss":77400,"takeProfit":78450,"alignedStrategies":["Time-Series Momentum","EMA Cross + ADX","SMA Trend Filter"], ...}
If alignedCount (2) <= conflictingCount (3), regardless of confidence, you MUST emit:
{"decision":"HOLD","executeTrade":false,"positionSizePercent":0,"entryPrice":<current>,"takeProfit":<current>,"stopLoss":<current>,"reasoning":["Conflict rule: 3 conflicting >= 2 aligned — no consensus."]}`;
