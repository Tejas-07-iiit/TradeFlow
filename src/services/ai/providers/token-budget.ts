/**
 * Per-model token budget throttle.
 *
 * The goal: never SEND a request we know will 429. Groq's free-tier
 * rate limits are per-model and refill on a 60-second sliding window;
 * we keep a local tally of tokens we've consumed in the last minute and
 * either delay or skip new requests when we're about to exceed.
 *
 * Lives module-scoped on the server: each model gets one `TokenBudget`
 * shared across every call site. Process-local (good enough for paper
 * trading; resets cleanly on dev-server restart).
 */

/**
 * Per-model TPM caps on Groq's free tier — leave a small margin below
 * the published number to absorb tokenizer drift between our estimate
 * and Groq's count. Raise these if you upgrade the Groq plan.
 */
const TPM_BUDGET_BY_MODEL: Record<string, number> = {
  // Groq free-tier per-model TPM caps.
  "openai/gpt-oss-120b": 28_000,
  "openai/gpt-oss-20b": 28_000,
  "llama-3.3-70b-versatile": 11_000,
  "llama-3.1-8b-instant": 28_000,
  "llama-4-scout-17b-16e-instruct": 28_000,
  "qwen/qwen3-32b": 28_000,
  // OpenRouter free models — limits vary per model but ~20K TPM is a
  // safe conservative cap (free tier caps RPD harder than TPM).
  "deepseek/deepseek-chat-v3-0324:free": 20_000,
  "deepseek/deepseek-v4-flash:free": 20_000,
  "meta-llama/llama-3.3-70b-instruct:free": 20_000,
  "qwen/qwen-2.5-72b-instruct:free": 20_000,
  "qwen/qwen3-next-80b-a3b-instruct:free": 20_000,
};
const DEFAULT_TPM_BUDGET = 11_000;

export function tpmBudgetFor(model: string): number {
  return TPM_BUDGET_BY_MODEL[model] ?? DEFAULT_TPM_BUDGET;
}

interface UsageEvent {
  /** ms-since-epoch when the call was sent. */
  at: number;
  /** total tokens (input + output estimate) attributed to this call. */
  tokens: number;
}

/** Window over which we sum usage. Matches Groq's 60s TPM window. */
const WINDOW_MS = 60_000;
/**
 * If a call would push us over the budget, wait up to this long for the
 * window to slide. Longer waits become "skip this cycle" because the
 * caller's tick will fire again soon anyway.
 */
const MAX_WAIT_MS = 25_000;

/**
 * Per-model cooldown registry. Populated by providers when the API returns
 * a 429 with a `retry-after` header — typically a longer-than-TPM window
 * like Groq's daily (TPD) cap. Every subsequent `reserve()` for that model
 * fails fast until the cooldown elapses, so the executor moves on instead
 * of burning HTTP roundtrips on calls guaranteed to 429.
 */
const cooldownUntilMs = new Map<string, number>();

export function markModelCooldown(model: string, retryAfterSec: number): void {
  if (!Number.isFinite(retryAfterSec) || retryAfterSec <= 0) return;
  const until = Date.now() + retryAfterSec * 1000;
  const prev = cooldownUntilMs.get(model) ?? 0;
  if (until > prev) cooldownUntilMs.set(model, until);
}

export function modelCooldownRemainingMs(model: string): number {
  const until = cooldownUntilMs.get(model);
  if (!until) return 0;
  const remaining = until - Date.now();
  if (remaining <= 0) {
    cooldownUntilMs.delete(model);
    return 0;
  }
  return remaining;
}

class TokenBudget {
  private events: UsageEvent[] = [];
  constructor(
    private readonly model: string,
    private readonly tpmCap: number,
  ) {}

  /**
   * Reserve `tokens` against the budget. Resolves when we have headroom
   * to send. Rejects with `BudgetExhaustedError` if waiting would take
   * longer than `MAX_WAIT_MS` — caller treats that as "skip this cycle".
   */
  async reserve(tokens: number): Promise<void> {
    const cooldownLeft = modelCooldownRemainingMs(this.model);
    if (cooldownLeft > 0) {
      throw new BudgetExhaustedError(
        this.model,
        this.tpmCap,
        this.tpmCap,
        cooldownLeft,
      );
    }
    while (true) {
      const now = Date.now();
      this.events = this.events.filter((e) => now - e.at < WINDOW_MS);
      const used = this.events.reduce((s, e) => s + e.tokens, 0);
      if (used + tokens <= this.tpmCap) {
        this.events.push({ at: now, tokens });
        return;
      }
      const oldest = this.events[0];
      const waitMs = oldest
        ? Math.max(500, WINDOW_MS - (now - oldest.at) + 100)
        : 500;
      if (waitMs > MAX_WAIT_MS) {
        console.warn(
          `[LLM] budget exhausted ${this.model} — used=${used}/${this.tpmCap} tpm, would wait ${(waitMs / 1000).toFixed(0)}s. Skipping.`,
        );
        throw new BudgetExhaustedError(this.model, used, this.tpmCap, waitMs);
      }
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }

  /**
   * Update the most-recent reservation with the actual token count from
   * the provider response. Replaces the estimate so future calls bill
   * against truth, not our worst-case guess.
   */
  recordActual(estimatedTokens: number, actualTokens: number): void {
    const last = this.events.at(-1);
    if (!last || last.tokens !== estimatedTokens) return;
    last.tokens = actualTokens;
  }
}

const budgets = new Map<string, TokenBudget>();

export function budgetFor(model: string): TokenBudget {
  let b = budgets.get(model);
  if (!b) {
    b = new TokenBudget(model, tpmBudgetFor(model));
    budgets.set(model, b);
  }
  return b;
}

export class BudgetExhaustedError extends Error {
  constructor(
    readonly model: string,
    readonly usedTokens: number,
    readonly capTokens: number,
    readonly wouldWaitMs: number,
  ) {
    super(
      `Token budget exhausted on ${model} (${usedTokens}/${capTokens} tpm)`,
    );
    this.name = "BudgetExhaustedError";
  }
}

/**
 * Rough token estimate from byte length. A character is ~0.3–0.4 tokens
 * for English; we use 0.28 to leave a safety margin — overestimating
 * means we hold back too soon, which is far better than underestimating
 * and getting a 429.
 */
export function estimatePromptTokens(messages: { content: string }[]): number {
  const chars = messages.reduce((s, m) => s + m.content.length, 0);
  return Math.ceil(chars * 0.28);
}
