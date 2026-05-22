import { GroqProvider } from "./groq";
import { LlmProviderError, type LlmProvider } from "./types";

export type { ChatMessage, LlmProvider } from "./types";
export { LlmProviderError } from "./types";

/**
 * Provider layer — Groq-only, multi-tier, multi-account.
 *
 * Two big design rules drive this module:
 *
 *   1. **Tier isolation.** Models are partitioned into three pools — LIGHT,
 *      MID, PREMIUM. A request never silently escalates across pools; the
 *      caller picks a tier and the chain stays inside it (with one explicit
 *      fallback step *down* when premium → mid when premium is exhausted).
 *      The 70B and GPT-OSS-120B are never reachable from a news/sentiment
 *      call, period.
 *
 *   2. **Dynamic registry.** Every model slot is env-driven. Unset slots
 *      are silently skipped so deployments can run with 2, 4, or 6 models
 *      depending on what their Groq account supports. There is no
 *      hardcoded model list anywhere in the runtime.
 *
 * Env contract (any subset may be set):
 *
 *     GROQ_MODEL_LIGHT_1   = llama-3.1-8b-instant
 *     GROQ_MODEL_LIGHT_2   = meta-llama/llama-4-scout-17b-16e-instruct
 *     GROQ_MODEL_MID_1     = openai/gpt-oss-20b
 *     GROQ_MODEL_MID_2     = qwen/qwen3-32b
 *     GROQ_MODEL_PREMIUM_1 = llama-3.3-70b-versatile
 *     GROQ_MODEL_PREMIUM_2 = openai/gpt-oss-120b
 *
 *     GROQ_API_KEY         = primary key  (account #1)
 *     GROQ_API_KEY_2..5    = additional keys (account #2..#5)
 *
 * Optional account-sharding hints (deterministic, defaults to safe behavior
 * if unset):
 *
 *     GROQ_TIER_ACCOUNT_PREMIUM = "1"      // account ids permitted for PREMIUM
 *     GROQ_TIER_ACCOUNT_MID     = "1,2"
 *     GROQ_TIER_ACCOUNT_LIGHT   = "2"
 *
 * Legacy purpose-keyed env (GROQ_MODEL_DECISION, _THESIS, _NEWS,
 * _SENTIMENT, _CHEAP, GROQ_MODEL) is still honoured — when a tier slot is
 * empty we fall back to the legacy keys so existing deployments keep
 * working without an env rewrite.
 */

export type LlmPurpose = "decision" | "thesis" | "news" | "sentiment" | "default";

export type LlmTier = "light" | "mid" | "premium";

export interface ProviderOptions {
  purpose?: LlmPurpose;
  /**
   * Tier override. When omitted, we use the canonical purpose→tier map:
   *   news       → light
   *   sentiment  → light
   *   thesis     → mid
   *   decision   → mid  (elite callers pass tier="premium" explicitly)
   *   default    → light
   */
  tier?: LlmTier;
  /** Preferred account id at the head of the chain, when present. */
  preferredAccountId?: number;
  /**
   * When false, premium-tier callers do NOT fall back to mid/light if every
   * premium model is cooled. Used by truly-critical elite paths where we
   * prefer to return a local-engine answer over downgrading silently.
   * Default: true.
   */
  allowCrossTierFallback?: boolean;
}

export interface GroqAccount {
  id: number;
  key: string;
}

function tierForPurpose(purpose: LlmPurpose): LlmTier {
  switch (purpose) {
    case "news":
    case "sentiment":
      return "light";
    case "thesis":
      return "mid";
    case "decision":
      // Decision defaults to MID; callers that have earned the premium tier
      // (elite alignment) pass tier: "premium" explicitly.
      return "mid";
    default:
      return "light";
  }
}

/**
 * Resolve the model id list for one tier — most-preferred first.
 *
 * Lookup order per tier slot:
 *   1. GROQ_MODEL_<TIER>_<N>           (new tier-keyed env)
 *   2. legacy purpose env, only for the matching tier
 *        - light:   GROQ_MODEL_CHEAP, GROQ_MODEL_NEWS, GROQ_MODEL_SENTIMENT
 *        - mid:     GROQ_MODEL_THESIS
 *        - premium: GROQ_MODEL_DECISION, GROQ_MODEL
 *
 * Duplicates are dropped. Returns [] if the tier is unconfigured — the
 * caller will then degrade to the next tier (or the local engine).
 */
function modelsForTier(tier: LlmTier): string[] {
  const upper = tier.toUpperCase();
  const result: string[] = [];
  const push = (raw: string | undefined) => {
    if (!raw) return;
    const v = raw.trim();
    if (!v) return;
    if (!result.includes(v)) result.push(v);
  };

  // Tier-keyed env, slots 1..4 so deployments can stack more variants per tier.
  for (let i = 1; i <= 4; i += 1) {
    push(process.env[`GROQ_MODEL_${upper}_${i}`]);
  }

  // Legacy fallbacks.
  if (tier === "light") {
    push(process.env.GROQ_MODEL_CHEAP);
    push(process.env.GROQ_MODEL_NEWS);
    push(process.env.GROQ_MODEL_SENTIMENT);
  } else if (tier === "mid") {
    push(process.env.GROQ_MODEL_THESIS);
  } else if (tier === "premium") {
    push(process.env.GROQ_MODEL_DECISION);
    push(process.env.GROQ_MODEL);
  }

  return result;
}

function collectGroqAccounts(): GroqAccount[] {
  const accounts: GroqAccount[] = [];
  const primary = process.env.GROQ_API_KEY?.trim();
  if (primary) accounts.push({ id: 1, key: primary });
  for (let i = 2; i <= 5; i += 1) {
    const k = process.env[`GROQ_API_KEY_${i}`]?.trim();
    if (k) accounts.push({ id: i, key: k });
  }
  return accounts;
}

/**
 * Account allow-list per tier. Defaults preserve current behaviour
 * (every account serves every tier) but deployments can set
 * GROQ_TIER_ACCOUNT_PREMIUM="1" and GROQ_TIER_ACCOUNT_LIGHT="2" to shard
 * load across keys.
 */
function accountsForTier(tier: LlmTier, all: GroqAccount[]): GroqAccount[] {
  const raw = process.env[`GROQ_TIER_ACCOUNT_${tier.toUpperCase()}`]?.trim();
  if (!raw) return all;
  const allowed = new Set(
    raw
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n)),
  );
  const filtered = all.filter((a) => allowed.has(a.id));
  // Never return an empty list — if config is wrong, fall back to all keys
  // so the system stays available rather than going dark.
  return filtered.length > 0 ? filtered : all;
}

let _rrCounter = 0;
function rotateAccounts(accounts: GroqAccount[]): GroqAccount[] {
  if (accounts.length <= 1) return accounts;
  const offset = _rrCounter++ % accounts.length;
  return [...accounts.slice(offset), ...accounts.slice(0, offset)];
}

let _bootLogged = false;
function logBootOnce(): void {
  if (_bootLogged) return;
  _bootLogged = true;
  const accounts = collectGroqAccounts();
  const tiers: LlmTier[] = ["light", "mid", "premium"];
  const summary = tiers
    .map((t) => `${t}=[${modelsForTier(t).join(", ") || "—"}]`)
    .join(" · ");
  if (accounts.length === 0) {
    console.warn(
      "[LLM/boot] no Groq API keys configured (GROQ_API_KEY unset) — Groq disabled in chain; system will run on local fallback only",
    );
  } else {
    console.info(
      `[LLM/boot] groq accounts=${accounts.map((a) => `#${a.id}`).join(",")} · ${summary}`,
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
 * Build the provider chain.
 *
 * Strategy:
 *   1. Resolve the *requested* tier from opts.tier (or tier-for-purpose).
 *   2. Cross-product (models in tier) × (accounts allowed for tier).
 *   3. If allowCrossTierFallback (default true), append the next-cheaper
 *      tier(s) at the end of the chain so a fully-cooled premium pool can
 *      still resolve to a mid model, etc. LIGHT never escalates upward —
 *      that's the institutional invariant the user demanded.
 *
 * Dedup is by `(model:accountId)`. Unset slots produce nothing.
 */
export function getLlmProviderChain(opts: ProviderOptions = {}): LlmProvider[] {
  logBootOnce();
  const allAccounts = collectGroqAccounts();
  if (allAccounts.length === 0) return [];

  const requestedTier =
    opts.tier ?? tierForPurpose(opts.purpose ?? "default");
  const allowCrossTierFallback = opts.allowCrossTierFallback !== false;

  const ordered = orderTiers(requestedTier, allowCrossTierFallback);
  const seen = new Set<string>();
  const chain: LlmProvider[] = [];

  for (const tier of ordered) {
    const models = modelsForTier(tier);
    if (models.length === 0) continue;
    let tierAccounts = accountsForTier(tier, allAccounts);
    tierAccounts = rotateAccounts(tierAccounts);
    if (opts.preferredAccountId !== undefined) {
      const idx = tierAccounts.findIndex((a) => a.id === opts.preferredAccountId);
      if (idx >= 0) {
        tierAccounts = [
          tierAccounts[idx],
          ...tierAccounts.slice(0, idx),
          ...tierAccounts.slice(idx + 1),
        ];
      }
    }
    for (const model of models) {
      for (const acct of tierAccounts) {
        const key = `groq:${model}:${acct.id}`;
        if (seen.has(key)) continue;
        try {
          chain.push(buildGroqProvider(model, acct));
          seen.add(key);
        } catch {
          // Construction errors (missing api key etc.) — skip silently.
        }
      }
    }
  }

  return chain;
}

/**
 * Tier ordering — request tier first, then approved fallback path.
 *
 *   light   → light only. NEVER ESCALATES (institutional rule).
 *   mid     → mid then light (downgrade only).
 *   premium → premium then mid then light (full downgrade chain).
 */
function orderTiers(requested: LlmTier, allowCrossTier: boolean): LlmTier[] {
  if (!allowCrossTier) return [requested];
  switch (requested) {
    case "light":
      return ["light"];
    case "mid":
      return ["mid", "light"];
    case "premium":
      return ["premium", "mid", "light"];
  }
}

/**
 * Single-provider convenience — returns the head of the chain. Throws
 * LlmProviderError when no provider can be constructed (no keys / no
 * configured models for the resolved tier).
 */
export function getLlmProvider(opts: ProviderOptions = {}): LlmProvider {
  const chain = getLlmProviderChain(opts);
  if (chain.length === 0) {
    throw new LlmProviderError(
      `No Groq model configured for tier=${opts.tier ?? tierForPurpose(opts.purpose ?? "default")}. ` +
        `Set at least one GROQ_MODEL_<TIER>_<N> env (or legacy GROQ_MODEL_*).`,
      undefined,
      "groq",
    );
  }
  return chain[0];
}

/**
 * Inspector — used by structured logging and the orchestrator to report
 * which models are wired for each tier without leaking provider internals.
 */
export function describeTierRegistry(): Record<LlmTier, string[]> {
  return {
    light: modelsForTier("light"),
    mid: modelsForTier("mid"),
    premium: modelsForTier("premium"),
  };
}

/** Inspector — accounts the process has loaded from env. */
export function describeAccounts(): GroqAccount[] {
  return collectGroqAccounts().map((a) => ({ id: a.id, key: "***" }));
}
