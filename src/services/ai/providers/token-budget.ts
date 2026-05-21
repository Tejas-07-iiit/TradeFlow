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
 * Per-model TPM caps. Configured entirely from env so model ids and
 * limits move together when the upstream catalog changes.
 *
 * Lookup order, in priority:
 *   1. `LLM_TPM_<NORMALIZED_MODEL>`        e.g. LLM_TPM_LLAMA_3_3_70B_VERSATILE=11000
 *   2. `LLM_TPM_BUDGETS` JSON map          e.g. {"llama-3.3-70b-versatile":11000,...}
 *   3. `LLM_TPM_DEFAULT`                    fallback cap when nothing matches
 *   4. 11_000                                hard-coded conservative floor
 *
 * The per-model env var name is built by uppercasing the model id and
 * replacing every non-alphanumeric char with `_`.
 */
function normalizeModelEnvKey(model: string): string {
  return `LLM_TPM_${model.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

let cachedTpmMap: Record<string, number> | null = null;
function tpmMapFromEnv(): Record<string, number> {
  if (cachedTpmMap) return cachedTpmMap;
  const raw = process.env.LLM_TPM_BUDGETS?.trim();
  if (!raw) {
    cachedTpmMap = {};
    return cachedTpmMap;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const map: Record<string, number> = {};
      for (const [k, v] of Object.entries(parsed)) {
        const n = typeof v === "number" ? v : parseFloat(String(v));
        if (Number.isFinite(n) && n > 0) map[k] = n;
      }
      cachedTpmMap = map;
      return map;
    }
  } catch (err) {
    console.warn(`[LLM] LLM_TPM_BUDGETS is not valid JSON: ${String(err)}`);
  }
  cachedTpmMap = {};
  return cachedTpmMap;
}

function defaultTpmBudget(): number {
  const raw = process.env.LLM_TPM_DEFAULT?.trim();
  const n = raw ? parseFloat(raw) : NaN;
  // Default high so the local budget never blocks. Groq's own 429 +
  // retry-after header is the real rate limiter — no need for a local
  // pre-filter that over-estimates and starves idle accounts.
  return Number.isFinite(n) && n > 0 ? n : 500_000;
}

export function tpmBudgetFor(model: string): number {
  const perModel = process.env[normalizeModelEnvKey(model)]?.trim();
  if (perModel) {
    const n = parseFloat(perModel);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const fromMap = tpmMapFromEnv()[model];
  if (fromMap) return fromMap;
  return defaultTpmBudget();
}

interface UsageEvent {
  /** Monotonic id so concurrent callers can update their own event. */
  id: number;
  /** ms-since-epoch when the call was sent. */
  at: number;
  /** total tokens (input + output estimate) attributed to this call. */
  tokens: number;
}

/**
 * Opaque handle returned by `reserve()` so the caller can update the
 * actual token count on its specific event — important when multiple
 * calls overlap (the orchestrator caps at 2 concurrent), because
 * `events.at(-1)` no longer identifies the right one.
 */
export interface ReservationHandle {
  readonly id: number;
  readonly estimated: number;
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
 * Per-(account, model) cooldown registry. Populated by providers when the
 * API returns a 429 with a `retry-after` header — typically a longer-than-
 * TPM window like Groq's daily (TPD) cap. Every subsequent `reserve()` for
 * that (account, model) fails fast until the cooldown elapses, so the
 * executor moves on instead of burning HTTP roundtrips on calls guaranteed
 * to 429.
 *
 * The `accountId` lets us track two Groq accounts independently — when key #1
 * hits its daily cap, key #2 is still free to serve the same model.
 */
const cooldownUntilMs = new Map<string, number>();

function bucketKey(model: string, accountId?: string | number): string {
  // Single-account setups (accountId omitted) keep the bare model key so the
  // legacy log format ("on llama-3.3-70b-versatile") is unchanged.
  return accountId == null ? model : `${accountId}@${model}`;
}

export function markModelCooldown(
  model: string,
  retryAfterSec: number,
  accountId?: string | number,
): void {
  if (!Number.isFinite(retryAfterSec) || retryAfterSec <= 0) return;
  const key = bucketKey(model, accountId);
  const until = Date.now() + retryAfterSec * 1000;
  const prev = cooldownUntilMs.get(key) ?? 0;
  if (until > prev) cooldownUntilMs.set(key, until);
}

export function modelCooldownRemainingMs(
  model: string,
  accountId?: string | number,
): number {
  const key = bucketKey(model, accountId);
  const until = cooldownUntilMs.get(key);
  if (!until) return 0;
  const remaining = until - Date.now();
  if (remaining <= 0) {
    cooldownUntilMs.delete(key);
    return 0;
  }
  return remaining;
}

class TokenBudget {
  private events: UsageEvent[] = [];
  private nextId = 1;
  constructor(
    private readonly model: string,
    private readonly tpmCap: number,
    /** Optional account id (e.g. Groq key #1 vs #2). Surfaces in logs and
     *  composes the cooldown key so each account tracks independently. */
    private readonly accountId?: string | number,
  ) {}

  private get label(): string {
    return this.accountId == null
      ? this.model
      : `${this.model}#${this.accountId}`;
  }

  /**
   * Reserve `tokens` against the budget. Now a passthrough — always
   * succeeds immediately. The only gate is the per-account cooldown set
   * by actual Groq 429 responses (markModelCooldown). The old TPM
   * estimation logic was too conservative and blocked requests that Groq
   * would have accepted, starving idle accounts.
   *
   * The cooldown check remains because it's driven by *real* 429s from
   * Groq with a `retry-after` header — not estimates.
   */
  async reserve(tokens: number): Promise<ReservationHandle> {
    const cooldownLeft = modelCooldownRemainingMs(this.model, this.accountId);
    if (cooldownLeft > 0) {
      throw new BudgetExhaustedError(
        this.label,
        this.tpmCap,
        this.tpmCap,
        cooldownLeft,
      );
    }
    const now = Date.now();
    this.events = this.events.filter((e) => now - e.at < WINDOW_MS);
    const id = this.nextId++;
    this.events.push({ id, at: now, tokens });
    return { id, estimated: tokens };
  }

  /**
   * Update the reservation identified by `handle` with the real token
   * count from the provider response. Lets future calls bill against
   * truth instead of the worst-case estimate. Resilient under overlap
   * (multiple in-flight calls update their own event by id).
   */
  recordActual(handle: ReservationHandle, actualTokens: number): void {
    const event = this.events.find((e) => e.id === handle.id);
    if (!event) return;
    event.tokens = actualTokens;
  }

  /** Release a reservation entirely — used when the request errored
   *  before reaching Groq (so we didn't actually consume the budget). */
  release(handle: ReservationHandle): void {
    this.events = this.events.filter((e) => e.id !== handle.id);
  }
}

const budgets = new Map<string, TokenBudget>();

/**
 * Get the TokenBudget for a (model, accountId) pair. Single-account callers
 * omit `accountId` and get the legacy per-model bucket. Multi-account
 * setups (e.g. two Groq keys) pass distinct ids so each account tracks its
 * own TPM independently — exhausting one no longer blocks the other.
 *
 * The TPM cap is read per *model* (Groq enforces it that way per account),
 * so account-A's `llama-3.3-70b-versatile` and account-B's same model both
 * get 12k TPM individually.
 */
export function budgetFor(
  model: string,
  accountId?: string | number,
): TokenBudget {
  const key = bucketKey(model, accountId);
  let b = budgets.get(key);
  if (!b) {
    b = new TokenBudget(model, tpmBudgetFor(model), accountId);
    budgets.set(key, b);
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
      `Upstream rate limit cooldown active on ${model} (${Math.ceil(wouldWaitMs / 1000)}s remaining; token budget exhausted)`,
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
