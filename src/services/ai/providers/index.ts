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
 *   2. Set the env var for that purpose (see lookup order below).
 *   3. Caller passes the purpose into `getLlmProvider({ purpose })`.
 *
 * Env var lookup order, per provider:
 *   groq:       GROQ_MODEL_<PURPOSE>       → GROQ_MODEL
 *   openrouter: OPENROUTER_MODEL_<PURPOSE> → OPENROUTER_MODEL
 *
 * No code-level fallbacks — every model id must come from env. If neither
 * env is set for the resolved provider, the call site is treated as
 * unconfigured and silently dropped from the chain.
 */
export type LlmPurpose = "decision" | "thesis" | "news" | "sentiment" | "default";

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
 * the other. Returns undefined when no env var is set — the caller
 * skips that link in the chain.
 */
function modelForPurpose(purpose: LlmPurpose, provider: string): string | undefined {
  const upper = purpose.toUpperCase();
  if (provider === "openrouter") {
    return (
      process.env[`OPENROUTER_MODEL_${upper}`]?.trim() ||
      process.env.OPENROUTER_MODEL?.trim() ||
      undefined
    );
  }
  return (
    process.env[`GROQ_MODEL_${upper}`]?.trim() ||
    process.env.GROQ_MODEL?.trim() ||
    undefined
  );
}

/**
 * OpenRouter fallback model list from `OPENROUTER_FALLBACK_MODELS`
 * (comma-separated). Empty when unset — chain will only contain the
 * configured primary OpenRouter model.
 */
function openRouterFallbackModels(): string[] {
  const raw = process.env.OPENROUTER_FALLBACK_MODELS?.trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((m) => m.trim())
    .filter((m) => m.length > 0);
}

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
 *   cheap   → start with `GROQ_MODEL_CHEAP` (or GROQ_MODEL) and only
 *             escalate to the configured purpose model if it errors.
 *             Routine evaluation, position management, low-alignment scans.
 *   premium → start with the configured purpose model (heavyweight).
 *             Reserved for elite snapshots that earned the deeper reasoning.
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
 * Throws on missing credentials or missing model env so we fail fast at
 * the boundary.
 */
export function getLlmProvider(opts: ProviderOptions = {}): LlmProvider {
  const purpose: LlmPurpose = opts.purpose ?? "default";
  const provider = providerForPurpose(purpose);
  const model = modelForPurpose(purpose, provider);
  if (!model) {
    throw new LlmProviderError(
      `No model configured for ${provider} purpose=${purpose}. ` +
        `Set ${provider === "openrouter" ? "OPENROUTER" : "GROQ"}_MODEL_${purpose.toUpperCase()} in env.`,
      undefined,
      provider,
    );
  }
  return buildProvider(provider, model);
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
 * on the primary model would otherwise leave the executor with no answer
 * for ~30 minutes.
 *
 * Chain composition (best-effort, dedup'd):
 *   1. Configured primary for the purpose.
 *   2. If primary is Groq, the cheap-tier Groq model from `GROQ_MODEL_CHEAP`
 *      (or `GROQ_MODEL`) — separate per-model bucket on the free tier.
 *   3. OpenRouter on the purpose's configured model.
 *   4. OpenRouter on each model in `OPENROUTER_FALLBACK_MODELS`.
 *
 * Providers that can't be constructed (missing creds or missing model env)
 * are silently omitted — they're only valid links when properly configured.
 */
export function getLlmProviderChain(opts: ProviderOptions = {}): LlmProvider[] {
  const purpose: LlmPurpose = opts.purpose ?? "default";
  const primary = providerForPurpose(purpose);
  const chain: LlmProvider[] = [];
  const seen = new Set<string>();
  const push = (provider: string, model: string | undefined) => {
    if (!model) return;
    const key = `${provider}:${model}`;
    if (seen.has(key)) return;
    try {
      chain.push(buildProvider(provider, model));
      seen.add(key);
    } catch {
      // Missing creds for this fallback — skip silently.
    }
  };

  const cheapModel =
    process.env.GROQ_MODEL_CHEAP?.trim() ||
    process.env.GROQ_MODEL?.trim() ||
    undefined;

  // Decision purpose with explicit tier overrides the default model order.
  // The configured `GROQ_MODEL_DECISION` env still wins as the "premium"
  // entry, so users can swap heavyweights without touching code.
  const decisionWithTier =
    purpose === "decision" && opts.tier != null && primary === "groq";
  if (decisionWithTier) {
    const configuredPremium = modelForPurpose(purpose, "groq");
    if (opts.tier === "cheap") {
      push("groq", cheapModel);
      push("groq", configuredPremium);
    } else {
      push("groq", configuredPremium);
      push("groq", cheapModel);
    }
  } else {
    push(primary, modelForPurpose(purpose, primary));
    if (primary === "groq") {
      push("groq", cheapModel);
    }
  }

  // OpenRouter expansion: try the user-configured model first, then sweep
  // the env-supplied fallback list. Any model that has been cooldown'd
  // (e.g. 404 "no endpoints found" or 429) is skipped on the next call
  // by TokenBudget.reserve, so the chain stays effective even when half
  // the free pool is upstream-throttled.
  if (process.env.OPENROUTER_API_KEY?.trim()) {
    if (primary !== "openrouter") {
      push("openrouter", modelForPurpose(purpose, "openrouter"));
    }
    for (const model of openRouterFallbackModels()) {
      push("openrouter", model);
    }
  }

  return chain;
}
