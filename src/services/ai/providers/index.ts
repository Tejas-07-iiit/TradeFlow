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
 * Enumerate every Groq API key in env, in priority order, tagged with a
 * stable 1-based id that matches the env var suffix:
 *
 *   GROQ_API_KEY     → accountId 1
 *   GROQ_API_KEY_2   → accountId 2
 *   GROQ_API_KEY_3   → accountId 3   (etc., up to 5)
 *
 * The id is what the token-budget tracker and cooldown registry key on,
 * so each Groq account maintains its own TPM bucket. Adding a second key
 * effectively doubles the system's Groq throughput because key #1
 * exhausting its 12k/min cap no longer blocks key #2 from serving the
 * same model.
 *
 * Returns an empty list when no keys are configured — callers building a
 * provider chain skip Groq entirely in that case.
 */
export interface GroqAccount {
  /** 1-based id matching the env var suffix. */
  id: number;
  /** Bearer token sent to Groq. */
  key: string;
}

function collectGroqAccounts(): GroqAccount[] {
  const accounts: GroqAccount[] = [];
  const primary = process.env.GROQ_API_KEY?.trim();
  if (primary) accounts.push({ id: 1, key: primary });
  // Allow up to GROQ_API_KEY_5 — adjust if you ever need more.
  for (let i = 2; i <= 5; i++) {
    const k = process.env[`GROQ_API_KEY_${i}`]?.trim();
    if (k) accounts.push({ id: i, key: k });
  }
  return accounts;
}

/**
 * Cold-start log: report how many Groq keys this process saw, so misconfigs
 * are obvious on boot rather than after the first rate limit. Logged once
 * per process via a side-effect-on-import sentinel.
 */
let _bootLogged = false;
function logBootOnce(): void {
  if (_bootLogged) return;
  _bootLogged = true;
  const accounts = collectGroqAccounts();
  if (accounts.length === 0) {
    console.warn(
      "[LLM/boot] no Groq API keys configured (GROQ_API_KEY unset) — Groq disabled in chain",
    );
  } else {
    console.info(
      `[LLM/boot] loaded ${accounts.length} Groq account(s): ${accounts.map((a) => `#${a.id}`).join(", ")}`,
    );
  }
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
 * lightweight — it's safe (and cheap) to call this per request.
 *
 * For Groq with multiple accounts configured, this picks the first one;
 * `getLlmProviderChain` is where multi-account round-robin actually
 * matters because the chain tries each account in turn.
 *
 * Throws on missing credentials or missing model env so we fail fast at
 * the boundary.
 */
export function getLlmProvider(opts: ProviderOptions = {}): LlmProvider {
  logBootOnce();
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
  if (provider === "groq") {
    const first = collectGroqAccounts()[0];
    if (!first) {
      throw new LlmProviderError(
        "GROQ_API_KEY is not set",
        undefined,
        "groq",
      );
    }
    return new GroqProvider({ apiKey: first.key, model, accountId: first.id });
  }
  return buildProvider(provider, model);
}

/**
 * Build a non-Groq provider for the chain. Groq goes through
 * `buildGroqProvider` so it can carry the explicit accountId.
 */
function buildProvider(provider: string, model: string): LlmProvider {
  switch (provider) {
    case "openrouter":
      return new OpenRouterProvider({
        apiKey: process.env.OPENROUTER_API_KEY?.trim() ?? "",
        model,
      });
    case "groq":
      // Fallback: caller didn't specify an account. Use the first one.
      const first = collectGroqAccounts()[0];
      if (!first) {
        throw new LlmProviderError("GROQ_API_KEY is not set", undefined, "groq");
      }
      return new GroqProvider({ apiKey: first.key, model, accountId: first.id });
    default:
      throw new LlmProviderError(
        `Unknown provider: ${provider}. Supported: groq, openrouter`,
        undefined,
        provider,
      );
  }
}

function buildGroqProvider(model: string, account: GroqAccount): LlmProvider {
  return new GroqProvider({
    apiKey: account.key,
    model,
    accountId: account.id,
  });
}

/**
 * Ordered fallback chain for a call site. Callers iterate until one
 * succeeds — designed for the decision call where a Groq TPD exhaustion
 * on the primary model would otherwise leave the executor with no answer
 * for ~30 minutes.
 *
 * Chain composition (best-effort, dedup'd):
 *   1. Configured primary model for the purpose, tried on *every* Groq
 *      account in order (key #1 → key #2 → …). Each account has its own
 *      TPM bucket, so when key #1 reports "12000/12000 tpm exhausted" we
 *      immediately try key #2 on the same model before stepping down.
 *   2. If primary is Groq, the cheap-tier Groq model (`GROQ_MODEL_CHEAP`),
 *      again across every Groq account.
 *   3. OpenRouter on the purpose's configured model.
 *   4. OpenRouter on each model in `OPENROUTER_FALLBACK_MODELS`.
 *
 * Dedup is by `(provider:model:accountId)` so the same Groq model on two
 * different accounts both make it into the chain.
 *
 * Providers that can't be constructed (missing creds or missing model env)
 * are silently omitted — they're only valid links when properly configured.
 */
export function getLlmProviderChain(opts: ProviderOptions = {}): LlmProvider[] {
  logBootOnce();
  const purpose: LlmPurpose = opts.purpose ?? "default";
  const primary = providerForPurpose(purpose);
  const chain: LlmProvider[] = [];
  const seen = new Set<string>();

  const groqAccounts = collectGroqAccounts();

  /** Push one Groq model once per available account. */
  const pushGroqAcrossAccounts = (model: string | undefined) => {
    if (!model) return;
    for (const acct of groqAccounts) {
      const key = `groq:${model}:${acct.id}`;
      if (seen.has(key)) continue;
      try {
        chain.push(buildGroqProvider(model, acct));
        seen.add(key);
      } catch {
        // Construction error — skip this link silently.
      }
    }
  };

  /** Push a non-Groq link (currently only OpenRouter). */
  const pushOther = (provider: string, model: string | undefined) => {
    if (!model) return;
    // OpenRouter is single-account today, but key by `:0` so the dedup
    // namespace stays uniform with the Groq entries above.
    const key = `${provider}:${model}:0`;
    if (seen.has(key)) return;
    try {
      chain.push(buildProvider(provider, model));
      seen.add(key);
    } catch {
      // Missing creds — skip silently.
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
      pushGroqAcrossAccounts(cheapModel);
      pushGroqAcrossAccounts(configuredPremium);
    } else {
      pushGroqAcrossAccounts(configuredPremium);
      pushGroqAcrossAccounts(cheapModel);
    }
  } else if (primary === "groq") {
    pushGroqAcrossAccounts(modelForPurpose(purpose, "groq"));
    pushGroqAcrossAccounts(cheapModel);
  } else {
    pushOther(primary, modelForPurpose(purpose, primary));
  }

  // OpenRouter expansion: try the user-configured model first, then sweep
  // the env-supplied fallback list. Any model that has been cooldown'd
  // (e.g. 404 "no endpoints found" or 429) is skipped on the next call
  // by TokenBudget.reserve, so the chain stays effective even when half
  // the free pool is upstream-throttled.
  if (process.env.OPENROUTER_API_KEY?.trim()) {
    if (primary !== "openrouter") {
      pushOther("openrouter", modelForPurpose(purpose, "openrouter"));
    }
    for (const model of openRouterFallbackModels()) {
      pushOther("openrouter", model);
    }
  }

  return chain;
}
