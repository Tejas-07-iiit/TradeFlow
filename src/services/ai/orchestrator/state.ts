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
  cooldownUntil = 0;
  last429Time = 0;
  latencies: number[] = [];
  events: RequestEvent[] = [];
  events429: number[] = [];

  constructor(readonly id: number) {}

  cleanEvents() {
    const now = Date.now();
    this.events = this.events.filter((e) => now - e.timestamp < 60000);
  }

  clean429Events() {
    const now = Date.now();
    this.events429 = this.events429.filter((t) => now - t < 60000);
  }

  get requestsLastMin() {
    this.cleanEvents();
    return this.events.length;
  }

  get tokensLastMin() {
    this.cleanEvents();
    return this.events.reduce((sum, e) => sum + e.tokens, 0);
  }

  get recent429s() {
    this.clean429Events();
    return this.events429.length;
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

  getHealthScore(model: string): number {
    const now = Date.now();
    const cdRemaining = Math.max(
      this.cooldownUntil - now,
      modelCooldownRemainingMs(model, this.id)
    );
    if (cdRemaining > 0) {
      return 0;
    }

    let score = 100;

    // -20 penalty per active request
    score -= this.activeCount * 20;

    // -30 penalty per recent 429
    score -= this.recent429s * 30;

    // -5 penalty per request in the last minute
    score -= this.requestsLastMin * 5;

    // -2 penalty per 1000 tokens used in the last minute
    score -= (this.tokensLastMin / 1000) * 2;

    return Math.max(0, Math.min(100, Math.round(score)));
  }

  getStatus(model: string): "healthy" | "cooldown" | "exhausted" {
    const now = Date.now();
    const cdRemaining = Math.max(
      this.cooldownUntil - now,
      modelCooldownRemainingMs(model, this.id)
    );
    if (cdRemaining > 0) {
      // Cooldown > 30 minutes indicates daily limit or severe exhaustion
      if (cdRemaining > 30 * 60 * 1000) {
        return "exhausted";
      }
      return "cooldown";
    }
    return "healthy";
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
 * Select the best Groq account id for the given model using health scoring.
 */
export function selectBestKey(model: string): number {
  const ids = collectGroqAccounts();
  if (ids.length === 0) return 1; // Default to key #1 if none configured

  const candidates = ids.map((id) => {
    const tracker = getTracker(id);
    const health = tracker.getHealthScore(model);
    const cd = Math.max(
      tracker.cooldownUntil - Date.now(),
      modelCooldownRemainingMs(model, id)
    );
    return { id, health, cd, tracker };
  });

  // Sort candidates by health score descending (highest health score first)
  candidates.sort((a, b) => b.health - a.health);

  // If the best health score is greater than 0, use it
  if (candidates[0].health > 0) {
    return candidates[0].id;
  }

  // All keys are under cooldown/zero health — choose the one with the shortest remaining cooldown
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
  tracker.events429.push(Date.now());
  tracker.cooldownUntil = Date.now() + retryAfterSec * 1000;
  tracker.last429Time = Date.now();

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
    const cd = Math.max(t.cooldownUntil - Date.now(), modelCooldownRemainingMs(model, id));
    return {
      accountId: id,
      activeCount: t.activeCount,
      requestsLastMin: t.requestsLastMin,
      tokensLastMin: t.tokensLastMin,
      cooldownLeftMs: Math.max(0, cd),
      totalRequests: t.totalRequests,
      total429s: t.total429s,
      avgLatencyMs: t.avgLatency,
      healthScore: t.getHealthScore(model),
      cooldownUntil: t.cooldownUntil,
      recent429s: t.recent429s,
      status: t.getStatus(model),
    };
  });
}

export function getRecentRateLimitEvents(): RateLimitEvent[] {
  return recentEvents;
}
