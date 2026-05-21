import { GroqProvider } from "./groq";
import { LlmProviderError, type LlmProvider } from "./types";

export type { ChatMessage, LlmProvider } from "./types";
export { LlmProviderError } from "./types";

/**
 * Single-vendor provider layer (Groq only).
 *
 * Earlier versions of this module multiplexed across Groq + OpenRouter, but
 * OpenRouter's free-tier daily quota was account-wide across all free models
 * and was getting exhausted before it could help, while its per-call latency
 * was noticeably worse than Groq. The system now runs entirely on Groq using
 * two independently-tracked accounts (`GROQ_API_KEY` + `GROQ_API_KEY_2`) so
 * the chain can survive one account's TPM/TPD bucket emptying without
 * pulling in a slower vendor.
 *
 * If you want to bring OpenRouter (or any other vendor) back later: add a
 * new provider class under `./<vendor>.ts` implementing `LlmProvider`, then
 * extend `getLlmProviderChain` to push it after the Groq accounts.
 */

/**
 * The set of distinct LLM call sites in the app. Each one gets its own
 * env var for model selection so heavy reasoning (decision) and light
 * summarization (thesis/news) ride independent Groq buckets via
 * `GROQ_MODEL_<PURPOSE>`.
 *
 * Env var lookup order:
 *   GROQ_MODEL_<PURPOSE>  →  GROQ_MODEL
 *
 * If neither env is set for a purpose, that call site is treated as
 * unconfigured — the chain will be empty and the orchestrator will fall
 * through to the local deterministic engine.
 */
export type LlmPurpose = "decision" | "thesis" | "news" | "sentiment" | "default";

/**
 * Model lookup for a purpose. Returns undefined when no env var is set —
 * the caller skips that link in the chain.
 */
function modelForPurpose(purpose: LlmPurpose): string | undefined {
  const upper = purpose.toUpperCase();
  return (
    process.env[`GROQ_MODEL_${upper}`]?.trim() ||
    process.env.GROQ_MODEL?.trim() ||
    undefined
  );
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
      "[LLM/boot] no Groq API keys configured (GROQ_API_KEY unset) — Groq disabled in chain; system will run on local fallback only",
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

function buildGroqProvider(model: string, account: GroqAccount): LlmProvider {
  return new GroqProvider({
    apiKey: account.key,
    model,
    accountId: account.id,
  });
}

/**
 * Resolve a single LLM provider for the given purpose. Returns the first
 * Groq account on the configured purpose model. Throws on missing creds
 * or missing model env so misconfigs surface at the boundary.
 *
 * Multi-account selection lives in `getLlmProviderChain` — every code
 * path that wants automatic fallback over both Groq accounts should call
 * the chain version instead.
 */
export function getLlmProvider(opts: ProviderOptions = {}): LlmProvider {
  logBootOnce();
  const purpose: LlmPurpose = opts.purpose ?? "default";
  const model = modelForPurpose(purpose);
  if (!model) {
    throw new LlmProviderError(
      `No model configured for groq purpose=${purpose}. ` +
        `Set GROQ_MODEL_${purpose.toUpperCase()} or GROQ_MODEL in env.`,
      undefined,
      "groq",
    );
  }
  const first = collectGroqAccounts()[0];
  if (!first) {
    throw new LlmProviderError("GROQ_API_KEY is not set", undefined, "groq");
  }
  return buildGroqProvider(model, first);
}

/**
 * Ordered fallback chain for a call site. Callers iterate until one
 * succeeds — designed for the decision call where a single account's
 * TPD exhaustion would otherwise leave the executor with no answer for
 * up to 30 minutes.
 *
 * Chain composition (best-effort, dedup'd):
 *   1. Configured primary (or tier-aware) model, tried on *every* Groq
 *      account in order (#1 → #2 → …). Each account has its own TPM
 *      bucket, so when #1 reports "12000/12000 tpm exhausted" we
 *      immediately try #2 on the same model before stepping down.
 *   2. If the primary call was for the decision purpose, the cheap-tier
 *      Groq model (`GROQ_MODEL_CHEAP`) again across every Groq account.
 *
 * Dedup is by `(provider:model:accountId)` so the same Groq model on
 * two accounts both make it into the chain.
 *
 * Links that can't be constructed (no model env, no API key) are silently
 * omitted. An empty chain means every higher-level fallback (local engine,
 * synthetic HOLD) takes over.
 */
export function getLlmProviderChain(opts: ProviderOptions = {}): LlmProvider[] {
  logBootOnce();
  const purpose: LlmPurpose = opts.purpose ?? "default";
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

  const cheapModel =
    process.env.GROQ_MODEL_CHEAP?.trim() ||
    process.env.GROQ_MODEL?.trim() ||
    undefined;

  // Decision purpose with explicit tier overrides the default model order.
  // The configured `GROQ_MODEL_DECISION` env still wins as the "premium"
  // entry, so users can swap heavyweights without touching code.
  const decisionWithTier = purpose === "decision" && opts.tier != null;
  if (decisionWithTier) {
    const configuredPremium = modelForPurpose(purpose);
    if (opts.tier === "cheap") {
      pushGroqAcrossAccounts(cheapModel);
      pushGroqAcrossAccounts(configuredPremium);
    } else {
      pushGroqAcrossAccounts(configuredPremium);
      pushGroqAcrossAccounts(cheapModel);
    }
  } else {
    pushGroqAcrossAccounts(modelForPurpose(purpose));
    if (purpose === "decision") {
      pushGroqAcrossAccounts(cheapModel);
    }
  }

  return chain;
}
