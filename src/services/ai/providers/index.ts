import { GroqProvider } from "./groq";
import { LlmProviderError, type LlmProvider } from "./types";

export type { ChatMessage, LlmProvider } from "./types";
export { LlmProviderError } from "./types";

/**
 * Resolve the active LLM provider from environment.
 *
 * Provider is chosen by `AI_PROVIDER` (default: "groq"). Each adapter pulls
 * its own credentials and model override. Keeping the factory thin means
 * adding OpenRouter/Gemini/Claude is a one-line case below.
 *
 * Throws on missing credentials rather than returning a stub — we'd rather
 * fail fast at the boundary than silently emit garbage thesis output.
 */
export function getLlmProvider(): LlmProvider {
  const provider = (process.env.AI_PROVIDER ?? "groq").toLowerCase();

  switch (provider) {
    case "groq":
      return new GroqProvider({
        apiKey: process.env.GROQ_API_KEY ?? "",
        model: process.env.GROQ_MODEL,
      });
    default:
      throw new LlmProviderError(
        `Unknown AI_PROVIDER: ${provider}. Supported: groq`,
        undefined,
        provider,
      );
  }
}
