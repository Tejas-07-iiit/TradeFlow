import type { SentimentInput } from "../ai/schemas";
import { getFearGreed } from "./fear-greed";
import { getNewsSnapshot } from "./cryptopanic";

/**
 * Fuse all sentiment sources we have configured for a symbol into the
 * SentimentInput shape the LLM expects.
 *
 * Every source is independently optional — if one fails or isn't configured
 * (e.g. no CRYPTOPANIC_TOKEN), it's just omitted from the result rather than
 * crashing the call path. If we have nothing at all, we return undefined so
 * the caller can drop the field from the LLM input entirely.
 */
export async function getSymbolSentiment(
  symbol: string,
): Promise<SentimentInput | undefined> {
  const [fng, news] = await Promise.all([
    getFearGreed().catch(() => null),
    getNewsSnapshot(symbol).catch(() => null),
  ]);

  const out: SentimentInput = {};
  if (fng) out.fearGreedIndex = fng.value;
  if (news?.sentiment) out.newsSentiment = news.sentiment;
  if (news?.headlines && news.headlines.length > 0) out.headlines = news.headlines;

  // Empty object means "nothing useful was available" — let the LLM input
  // omit the field entirely rather than carry empty noise.
  return Object.keys(out).length === 0 ? undefined : out;
}
