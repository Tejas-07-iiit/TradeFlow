/**
 * AI Orchestrator state and load balancer.
 *
 * Tracks the live load, rate limit events, and cooldowns for all configured
 * Groq API keys, allowing the scheduler to route jobs intelligently.
 */

import { modelCooldownRemainingMs, markModelCooldown } from "../providers/token-budget";
import type { KeyLoadStats, RateLimitEvent } from "./types";

interface RequestEvent {
  timestamp: number;
  tokens: number;
}

class AccountTracker {
  activeCount = 0;
  totalRequests = 0;
  total429s = 0;
  latencies: number[] = [];
  events: RequestEvent[] = [];

  constructor(readonly id: number) {}

  cleanEvents() {
    const now = Date.now();
    this.events = this.events.filter((e) => now - e.timestamp < 60000);
  }

  get requestsLastMin() {
    this.cleanEvents();
    return this.events.length;
  }

  get tokensLastMin() {
    this.cleanEvents();
    return this.events.reduce((sum, e) => sum + e.tokens, 0);
  }

  addEvent(tokens: number) {
    this.events.push({ timestamp: Date.now(), tokens });
    this.totalRequests++;
    this.activeCount++;
  }

  recordEnd(durationMs: number, actualTokens?: number) {
    this.activeCount = Math.max(0, this.activeCount - 1);
    this.latencies.push(durationMs);
    if (this.latencies.length > 10) this.latencies.shift();
    if (actualTokens !== undefined && this.events.length > 0) {
      // Find the event and update its token count
      const last = this.events[this.events.length - 1];
      if (last) last.tokens = actualTokens;
    }
  }

  recordFailure() {
    this.activeCount = Math.max(0, this.activeCount - 1);
  }

  get avgLatency() {
    if (this.latencies.length === 0) return 0;
    const sum = this.latencies.reduce((a, b) => a + b, 0);
    return Math.round(sum / this.latencies.length);
  }
}

// Global process-wide load balancer state.
const trackers: Map<number, AccountTracker> = new Map();
const recentEvents: RateLimitEvent[] = [];
const MAX_EVENTS = 20;

function getTracker(id: number): AccountTracker {
  let t = trackers.get(id);
  if (!t) {
    t = new AccountTracker(id);
    trackers.set(id, t);
  }
  return t;
}

export function collectGroqAccounts(): number[] {
  const ids: number[] = [];
  if (process.env.GROQ_API_KEY?.trim()) ids.push(1);
  for (let i = 2; i <= 5; i++) {
    if (process.env[`GROQ_API_KEY_${i}`]?.trim()) ids.push(i);
  }
  return ids;
}

/**
 * Select the best Groq account id for the given model.
 *
 * Selection rules:
 * 1. Filter out keys that are currently under cooldown.
 * 2. If all keys are under cooldown, select the one with the shortest cooldown.
 * 3. Choose the key with the fewest active requests.
 * 4. If active requests are tied, choose the key with the fewest tokens used in the last minute.
 * 5. If tokens are tied, choose the key with the fewest requests in the last minute.
 */
export function selectBestKey(model: string): number {
  const ids = collectGroqAccounts();
  if (ids.length === 0) return 1; // Default to key #1 if none configured

  const candidates = ids.map((id) => {
    const cd = modelCooldownRemainingMs(model, id);
    const tracker = getTracker(id);
    return { id, cd, tracker };
  });

  // 1. Check for keys not in cooldown
  const available = candidates.filter((c) => c.cd === 0);

  if (available.length > 0) {
    // Sort by active count, then tokens last min, then requests last min
    available.sort((a, b) => {
      if (a.tracker.activeCount !== b.tracker.activeCount) {
        return a.tracker.activeCount - b.tracker.activeCount;
      }
      if (a.tracker.tokensLastMin !== b.tracker.tokensLastMin) {
        return a.tracker.tokensLastMin - b.tracker.tokensLastMin;
      }
      return a.tracker.requestsLastMin - b.tracker.requestsLastMin;
    });
    return available[0].id;
  }

  // 2. All are in cooldown — choose the one with the shortest remaining cooldown
  candidates.sort((a, b) => a.cd - b.cd);
  return candidates[0].id;
}

export function recordRequestStart(accountId: number, estimatedTokens: number) {
  const tracker = getTracker(accountId);
  tracker.addEvent(estimatedTokens);
}

export function recordRequestEnd(accountId: number, durationMs: number, actualTokens?: number) {
  const tracker = getTracker(accountId);
  tracker.recordEnd(durationMs, actualTokens);
}

export function recordRequestFailure(accountId: number) {
  const tracker = getTracker(accountId);
  tracker.recordFailure();
}

export function record429Event(
  accountId: number,
  model: string,
  retryAfterSec: number,
  isTpd: boolean,
  message: string,
) {
  const tracker = getTracker(accountId);
  tracker.total429s++;

  // Log cooldown locally
  markModelCooldown(model, retryAfterSec, accountId);

  const event: RateLimitEvent = {
    timestamp: new Date().toISOString(),
    accountId,
    model,
    retryAfterSec,
    isTpd,
    message,
  };

  recentEvents.unshift(event);
  if (recentEvents.length > MAX_EVENTS) {
    recentEvents.pop();
  }
}

export function getLiveKeysStats(model: string): KeyLoadStats[] {
  const ids = collectGroqAccounts();
  return ids.map((id) => {
    const t = getTracker(id);
    return {
      accountId: id,
      activeCount: t.activeCount,
      requestsLastMin: t.requestsLastMin,
      tokensLastMin: t.tokensLastMin,
      cooldownLeftMs: modelCooldownRemainingMs(model, id),
      totalRequests: t.totalRequests,
      total429s: t.total429s,
      avgLatencyMs: t.avgLatency,
    };
  });
}

export function getRecentRateLimitEvents(): RateLimitEvent[] {
  return recentEvents;
}
