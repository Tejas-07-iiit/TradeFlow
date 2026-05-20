import { GroqProvider } from "./groq";
import { OpenRouterProvider } from "./openrouter";
import { LlmProviderError, type LlmProvider } from "./types";

export type { ChatMessage, LlmProvider } from "./types";
export { LlmProviderError } from "./types";

/**
 * The set of distinct LLM call sites in the app. Each one gets its own
 * env var for model selection so heavy reasoning (decision) and light
 * summarization (thesis/news) can ride separate Groq rate-limit buckets.
 *
 * Adding a new purpose:
 *   1. Add a key here.
 *   2. Add a default model in `DEFAULT_MODEL_BY_PURPOSE`.
 *   3. Caller passes the purpose into `getLlmProvider({ purpose })`.
 *
 * Env var lookup order for each purpose:
 *   1. `GROQ_MODEL_<PURPOSE>` (e.g. `GROQ_MODEL_DECISION`)
 *   2. `GROQ_MODEL` (legacy single-model override)
 *   3. `DEFAULT_MODEL_BY_PURPOSE[purpose]`
 */
export type LlmPurpose = "decision" | "thesis" | "news" | "sentiment" | "default";

const DEFAULT_MODEL_BY_PURPOSE: Record<LlmPurpose, string> = {
  // Decision needs a NON-reasoning model. gpt-oss-120b and -20b burn
  // output tokens on hidden chain-of-thought before emitting JSON, so
  // they regularly hit "max completion tokens reached" on this schema.
  // llama-3.3-70b-versatile emits the JSON directly; its tighter 11K
  // TPM bucket is handled by the per-model token-budget throttle.
  decision: "llama-3.3-70b-versatile",
  // Lighter — formats a structured market read into a short narrative.
  // llama-3.1-8b-instant: universally available on every Groq tier,
  // 30K TPM, sub-second latency. Plenty for advisory output.
  thesis: "llama-3.1-8b-instant",
  news: "llama-3.1-8b-instant",
  sentiment: "llama-3.1-8b-instant",
  default: "llama-3.3-70b-versatile",
};


/**
 * Provider lookup per purpose. Lets you put trade decisions on Groq
 * (low-latency reasoning) while keeping thesis/news/sentiment on
 * OpenRouter (independent rate-limit budget).
 *
 * Env var lookup order:
 *   1. `AI_PROVIDER_<PURPOSE>` (per-call-site override)
 *   2. `AI_PROVIDER` (global default)
 *   3. "groq"
 */
function providerForPurpose(purpose: LlmPurpose): string {
  const envKey = `AI_PROVIDER_${purpose.toUpperCase()}`;
  return (
    process.env[envKey] ??
    process.env.AI_PROVIDER ??
    "groq"
  ).toLowerCase();
}

/**
 * Model lookup, scoped to the resolved provider so each vendor has its
 * own env namespace and never accidentally feeds an OpenAI/Groq id to
 * the other.
 *
 * Env var lookup order, per provider:
 *   groq:       GROQ_MODEL_<PURPOSE> → GROQ_MODEL → default
 *   openrouter: OPENROUTER_MODEL_<PURPOSE> → OPENROUTER_MODEL → default
 */
function modelForPurpose(purpose: LlmPurpose, provider: string): string {
  const upper = purpose.toUpperCase();
  if (provider === "openrouter") {
    return (
      process.env[`OPENROUTER_MODEL_${upper}`] ??
      process.env.OPENROUTER_MODEL ??
      DEFAULT_OPENROUTER_MODEL_BY_PURPOSE[purpose]
    );
  }
  return (
    process.env[`GROQ_MODEL_${upper}`] ??
    process.env.GROQ_MODEL ??
    DEFAULT_MODEL_BY_PURPOSE[purpose]
  );
}

// `deepseek/deepseek-chat-v3-0324:free` was the previous default but
// OpenRouter has pulled it from the catalog — every call 404s with "no
// endpoints found". `deepseek-v4-flash:free` is the current free-tier
// successor and was the one model returning 200 in our probe; the rest
// of OPENROUTER_FALLBACK_FREE_MODELS provides redundancy when it's
// upstream-rate-limited.
const DEFAULT_OPENROUTER_MODEL_BY_PURPOSE: Record<LlmPurpose, string> = {
  decision: "deepseek/deepseek-v4-flash:free",
  thesis: "deepseek/deepseek-v4-flash:free",
  news: "deepseek/deepseek-v4-flash:free",
  sentiment: "deepseek/deepseek-v4-flash:free",
  default: "deepseek/deepseek-v4-flash:free",
};

/**
 * Additional OpenRouter free models we'll cycle through when the primary
 * OpenRouter pick is cooldown'd or upstream rate-limited. Verified
 * present in OpenRouter's catalog as of 2026-05; if endpoints disappear,
 * the per-model cooldown will skip them automatically.
 */
const OPENROUTER_FALLBACK_FREE_MODELS = [
  "deepseek/deepseek-v4-flash:free",
  "meta-llama/llama-3.3-70b-instruct:free",
  "qwen/qwen3-next-80b-a3b-instruct:free",
];

/**
 * Round-robin API key picker. Set `GROQ_API_KEY_2` (and `_3`, etc.) in env
 * and we'll rotate between them, doubling effective rate limits per
 * separate Groq account. Single-key setups continue to work unchanged.
 *
 * The counter is module-scoped and process-local — fine for paper trading,
 * not durable across restarts (acceptable for round-robin).
 */
let keyCursor = 0;
function pickApiKey(): string {
  const keys = collectApiKeys();
  if (keys.length === 0) return "";
  const idx = keyCursor % keys.length;
  keyCursor = (keyCursor + 1) % keys.length;
  return keys[idx];
}

function collectApiKeys(): string[] {
  const keys: string[] = [];
  const primary = process.env.GROQ_API_KEY?.trim();
  if (primary) keys.push(primary);
  // Allow up to GROQ_API_KEY_5 — adjust if you ever need more.
  for (let i = 2; i <= 5; i++) {
    const k = process.env[`GROQ_API_KEY_${i}`]?.trim();
    if (k) keys.push(k);
  }
  return keys;
}

/**
 * Quality tier for the call. Lets the chain swap order without renaming
 * models or duplicating env config.
 *
 *   cheap   → start with the 8B (or equivalent free OpenRouter) model and
 *             only escalate to the heavyweight if it errors. Routine
 *             evaluation, position management, low-alignment scans.
 *   premium → start with the heavyweight (70B llama). Reserved for elite
 *             snapshots that earned the deeper reasoning.
 *
 * Default (undefined) preserves the legacy chain order so non-decision
 * call sites don't change behavior.
 */
export type LlmTier = "cheap" | "premium";

export interface ProviderOptions {
  /** Which call site is this for? Drives model selection. */
  purpose?: LlmPurpose;
  /** Routing tier — overrides the default chain order when set. */
  tier?: LlmTier;
}

/**
 * Resolve an LLM provider for the given purpose. The returned instance is
 * lightweight — it's safe (and cheap) to call this per request so each
 * call site picks up fresh env / API-key rotation state.
 *
 * Throws on missing credentials so we fail fast at the boundary.
 */
export function getLlmProvider(opts: ProviderOptions = {}): LlmProvider {
  const purpose: LlmPurpose = opts.purpose ?? "default";
  const provider = providerForPurpose(purpose);
  return buildProvider(provider, modelForPurpose(purpose, provider));
}

function buildProvider(provider: string, model: string): LlmProvider {
  switch (provider) {
    case "groq":
      return new GroqProvider({ apiKey: pickApiKey(), model });
    case "openrouter":
      return new OpenRouterProvider({
        apiKey: process.env.OPENROUTER_API_KEY?.trim() ?? "",
        model,
      });
    default:
      throw new LlmProviderError(
        `Unknown provider: ${provider}. Supported: groq, openrouter`,
        undefined,
        provider,
      );
  }
}

/**
 * Ordered fallback chain for a call site. Callers iterate until one
 * succeeds — designed for the decision call where a Groq TPD exhaustion
 * on llama-3.3-70b would otherwise leave the executor with no answer
 * for ~30 minutes.
 *
 * Chain composition (best-effort, dedup'd):
 *   1. Configured primary for the purpose.
 *   2. If primary is Groq, the same purpose on `llama-3.1-8b-instant`
 *      (separate per-model bucket on the free tier, so a 70B TPD hit
 *      doesn't block it).
 *   3. OpenRouter on the purpose's configured model, when an API key is
 *      present and OpenRouter isn't already the primary.
 *
 * Providers that can't be constructed (missing creds) are silently
 * omitted — they're only valid links when properly configured.
 */
export function getLlmProviderChain(opts: ProviderOptions = {}): LlmProvider[] {
  const purpose: LlmPurpose = opts.purpose ?? "default";
  const primary = providerForPurpose(purpose);
  const chain: LlmProvider[] = [];
  const seen = new Set<string>();
  const push = (provider: string, model: string) => {
    const key = `${provider}:${model}`;
    if (seen.has(key)) return;
    try {
      chain.push(buildProvider(provider, model));
      seen.add(key);
    } catch {
      // Missing creds for this fallback — skip silently.
    }
  };

  // Decision purpose with explicit tier overrides the default model order.
  // The configured `GROQ_MODEL_DECISION` env still wins as the "premium"
  // entry if set, so users can swap heavyweights without touching code.
  const decisionWithTier =
    purpose === "decision" && opts.tier != null && primary === "groq";
  if (decisionWithTier) {
    const configuredPremium = modelForPurpose(purpose, "groq");
    const CHEAP_MODEL = "llama-3.1-8b-instant";
    if (opts.tier === "cheap") {
      push("groq", CHEAP_MODEL);
      push("groq", configuredPremium);
    } else {
      push("groq", configuredPremium);
      push("groq", CHEAP_MODEL);
    }
  } else {
    push(primary, modelForPurpose(purpose, primary));
    if (primary === "groq") {
      push("groq", "llama-3.1-8b-instant");
    }
  }

  // OpenRouter expansion: try the user-configured model first, then sweep
  // the known-good free-model list. Any model that has been cooldown'd
  // (e.g. 404 "no endpoints found" or 429) is skipped on the next call
  // by TokenBudget.reserve, so the chain stays effective even when half
  // the free pool is upstream-throttled.
  if (process.env.OPENROUTER_API_KEY?.trim()) {
    if (primary !== "openrouter") {
      push("openrouter", modelForPurpose(purpose, "openrouter"));
    }
    for (const model of OPENROUTER_FALLBACK_FREE_MODELS) {
      push("openrouter", model);
    }
  }

  return chain;
}
