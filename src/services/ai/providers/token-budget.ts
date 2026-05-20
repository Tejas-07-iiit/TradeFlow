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
  return Number.isFinite(n) && n > 0 ? n : 11_000;
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
  private nextId = 1;
  constructor(
    private readonly model: string,
    private readonly tpmCap: number,
  ) {}

  /**
   * Reserve `tokens` against the budget. Resolves with a handle the
   * caller passes back to `recordActual` once the API response lands.
   * Rejects with `BudgetExhaustedError` if waiting would take longer
   * than `MAX_WAIT_MS` — caller treats that as "skip this cycle".
   */
  async reserve(tokens: number): Promise<ReservationHandle> {
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
        const id = this.nextId++;
        this.events.push({ id, at: now, tokens });
        return { id, estimated: tokens };
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
