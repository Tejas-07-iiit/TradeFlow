import type { ChatMessage } from "../providers";
import type { ThesisInput } from "../schemas";

/**
 * Prompt template for the market-thesis call.
 *
 * Tone is set hard in the system message — institutional analyst register,
 * probability language only, no price targets, no "moon", no profit promises.
 * The user message is a single JSON blob so the model parses it as structured
 * input rather than free prose.
 *
 * We also re-state the JSON schema in the prompt. Groq's response_format
 * enforces that the reply IS JSON, but not its *shape*; restating the schema
 * inline materially improves field-name adherence on smaller Llama models.
 */
export function buildMarketThesisPrompt(input: ThesisInput): ChatMessage[] {
  return [
    {
      role: "system",
      content: SYSTEM_PROMPT,
    },
    {
      role: "user",
      content: [
        "Analyze the following intraday market snapshot and produce a structured trade thesis.",
        "",
        "INPUT:",
        JSON.stringify(input, null, 2),
        "",
        "Respond with a SINGLE JSON object matching this schema (no prose, no markdown):",
        SCHEMA_REMINDER,
      ].join("\n"),
    },
  ];
}

const SYSTEM_PROMPT = `You are a senior institutional crypto trading analyst.

Your job is to read a structured market snapshot and produce a brief, probability-weighted thesis for an intraday trader. You are NOT a price predictor or a hype account.

HARD RULES:
- Output ONE JSON object. No prose, no markdown fences, no commentary outside the JSON.
- Use probability and uncertainty language ("likely", "tentative", "elevated risk"). Never assert outcomes.
- Never predict exact future prices. Never promise profits. Never mention "moon", "guaranteed", "free money", or similar.
- If indicators conflict, say so. If volatility is low or the regime is compressed, acknowledge that signals are weak.
- Risk commentary must reference a concrete invalidation idea (e.g. loss of a structural level, ATR expansion, ADX collapse) — not generic warnings.
- Setup quality must be conservative: "A+" and "A" are rare; default to "B" or below unless trend, momentum, and HTF bias clearly align.
- Confidence is bounded 0-100. Reserve values >75 for cases where multiple independent factors align.

VOICE:
"Momentum improving on lower timeframes while higher timeframe remains range-bound. Bullish continuation possible if resistance breaks with volume confirmation." — YES
"BTC going to moon 🚀" — NO`;

const SCHEMA_REMINDER = `{
  "marketBias": "strongly bearish" | "moderately bearish" | "neutral" | "moderately bullish" | "strongly bullish",
  "confidence": integer 0-100,
  "setupQuality": "A+" | "A" | "B+" | "B" | "C" | "Avoid",
  "summary": string (one-paragraph market read, <=400 chars),
  "riskCommentary": string (concrete invalidation idea, <=400 chars),
  "tradeThesis": string (intraday plan in probability language, <=500 chars)
}`;
