import type { StrategyContext, StrategyDefinition, StrategyOutput } from "@/strategy-core/types";

/**
 * News + Fear-Greed sentiment fusion.
 *
 * Maps to the Quantpedia "Market Sentiment and an Overnight Anomaly" /
 * "How to Use Lexical Density of Company Filings" family — sentiment-driven
 * signals on top of structured data.
 *
 * Logic:
 *   - very bullish news + fear-greed < 35 (greed building from fear)  → BUY
 *   - very bearish news + fear-greed > 75 (fear from extreme greed)   → SELL
 *   - very bullish news with fear-greed already > 80                  → contrarian SELL
 *   - very bearish news with fear-greed already < 20                  → contrarian BUY
 *
 * Designed to add a quiet voice — sentiment alone never wins a high
 * confidence, but it can tip a 50/50 directional vote.
 */
function evaluate(ctx: StrategyContext): StrategyOutput {
  const s = ctx.sentiment;
  const reasoning: string[] = [];

  if (!s) {
    return shell({
      signal: "HOLD",
      confidence: 25,
      reasoning: ["No sentiment context available."],
      momentumScore: 0,
    });
  }

  const news = s.newsSentiment;
  const social = s.socialSentiment;
  const fgi = s.fearGreedIndex ?? 50;

  let signal: StrategyOutput["signal"] = "HOLD";
  let confidence = 35;
  let momentumScore = 0;

  const newsBull = news === "bullish" || news === "very bullish";
  const newsBear = news === "bearish" || news === "very bearish";
  const socialBull = social === "bullish" || social === "very bullish";
  const socialBear = social === "bearish" || social === "very bearish";

  if (newsBull && fgi < 35) {
    signal = "BUY";
    confidence = 55;
    momentumScore = 45;
    reasoning.push(`Bullish news with Fear-Greed ${fgi} — sentiment turning up from fear.`);
  } else if (newsBear && fgi > 65) {
    signal = "SELL";
    confidence = 55;
    momentumScore = -45;
    reasoning.push(`Bearish news with Fear-Greed ${fgi} — greed cracking on negative tape.`);
  } else if (newsBull && fgi > 80) {
    signal = "SELL";
    confidence = 50;
    momentumScore = -30;
    reasoning.push(`Bullish news but Fear-Greed extreme (${fgi}) — contrarian fade.`);
  } else if (newsBear && fgi < 20) {
    signal = "BUY";
    confidence = 50;
    momentumScore = 30;
    reasoning.push(`Bearish news with Fear-Greed extreme (${fgi}) — contrarian capitulation.`);
  } else {
    reasoning.push(
      `News ${news ?? "n/a"}, social ${social ?? "n/a"}, fear-greed ${fgi} — no sentiment edge.`,
    );
  }

  if (signal !== "HOLD") {
    if (socialBull && signal === "BUY") {
      confidence += 5;
      reasoning.push("Social sentiment confirms.");
    } else if (socialBear && signal === "SELL") {
      confidence += 5;
      reasoning.push("Social sentiment confirms.");
    } else if ((socialBull && signal === "SELL") || (socialBear && signal === "BUY")) {
      confidence -= 8;
      reasoning.push("Social sentiment disagrees — moderating confidence.");
    }
  }

  return shell({ signal, confidence, reasoning, momentumScore });
}

function shell(args: {
  signal: StrategyOutput["signal"];
  confidence: number;
  reasoning: string[];
  momentumScore: number;
}): StrategyOutput {
  return {
    strategyId: "news-fear-greed",
    strategyName: "News + Fear-Greed Sentiment",
    category: "sentiment",
    signal: args.signal,
    confidence: Math.round(Math.min(75, Math.max(0, args.confidence))),
    timeframe: "intraday",
    regimeFit: ["Sideways", "Reversal", "High Volatility", "Trending Up", "Trending Down"],
    riskLevel: "Medium",
    reasoning: args.reasoning,
    indicatorsUsed: ["News sentiment", "Social sentiment", "Fear-Greed Index"],
    entryConditions: [
      "Bullish news + low fear-greed (or vice versa)",
      "Contrarian fade at sentiment extremes",
    ],
    exitConditions: ["Fear-greed mean-reverts", "News turns neutral"],
    stopLossLogic: "Volatility-anchored — 1.5× ATR.",
    takeProfitLogic: "Discretionary; ride until sentiment fades.",
    volatilityScore: 50,
    momentumScore: args.momentumScore,
    trendScore: args.momentumScore * 0.3,
  };
}

export const NewsFearGreed: StrategyDefinition = {
  id: "news-fear-greed",
  name: "News + Fear-Greed Sentiment",
  category: "sentiment",
  description:
    "Sentiment-fusion strategy combining news, social, and Fear-Greed Index. Adds a directional tilt; never a primary entry.",
  timeframes: ["intraday"],
  preferredRegimes: ["Sideways", "Reversal", "High Volatility", "Trending Up", "Trending Down"],
  minCandles: 1,
  evaluate,
  enabled: true,
};
