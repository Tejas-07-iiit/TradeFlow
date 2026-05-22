/**
 * AI Orchestrator state and load balancer.
 *
 * Tracks the live load, rate limit events, and cooldowns for all configured
 * Groq API keys, allowing the scheduler to route jobs intelligently.
 */

import { modelCooldownRemainingMs, markModelCooldown, getBudgetStats } from "../providers/token-budget";
import type { KeyLoadStats, RateLimitEvent, AdminSettings } from "./types";

interface RequestEvent {
  timestamp: number;
  tokens: number;
}

// Global process-wide admin settings with defaults.
const adminSettings: AdminSettings = {
  pausedModels: [],
  disabledAccounts: [],
  routingWeights: {
    "1": 50,
    "2": 50,
    "3": 33,
    "4": 25,
    "5": 20,
  },
  concurrencyLimits: {
    premium: 1,
    lightweight: 3,
    background: 2,
  },
  aggressiveMode: false,
  lowTokenMode: false,
  emergencyStop: false,
  disablePremium: false,
  maintenanceMode: false,
};

export function getAdminSettings(): AdminSettings {
  return adminSettings;
}

export function updateAdminSettings(settings: Partial<AdminSettings>): AdminSettings {
  Object.assign(adminSettings, settings);
  return adminSettings;
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
    if (adminSettings.pausedModels.includes(model)) {
      return 0;
    }
    if (adminSettings.disabledAccounts.includes(this.id)) {
      return 0;
    }

    const now = Date.now();
    const cdRemaining = Math.max(
      this.cooldownUntil - now,
      modelCooldownRemainingMs(model, this.id)
    );
    if (cdRemaining > 0) {
      return 0;
    }

    // Daily budget check integration
    const budget = getBudgetStats(model, this.id);
    if (budget.dailyUsage >= budget.dailyLimit) {
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
    if (adminSettings.pausedModels.includes(model)) {
      return "exhausted";
    }
    if (adminSettings.disabledAccounts.includes(this.id)) {
      return "exhausted";
    }
    const budget = getBudgetStats(model, this.id);
    if (budget.dailyUsage >= budget.dailyLimit) {
      return "exhausted";
    }
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
 * Uses probabilistic (weighted random) selection of active healthy accounts.
 */
export function selectBestKey(model: string): number {
  const ids = collectGroqAccounts().filter((id) => !adminSettings.disabledAccounts.includes(id));
  if (ids.length === 0) return 1; // Default to key #1 if none configured

  const candidates = ids.map((id) => {
    const tracker = getTracker(id);
    const health = tracker.getHealthScore(model);
    const cd = Math.max(
      tracker.cooldownUntil - Date.now(),
      modelCooldownRemainingMs(model, id)
    );
    const weight = adminSettings.routingWeights[String(id)] ?? 50;
    return { id, health, cd, tracker, weight };
  });

  const activeCandidates = candidates.filter((c) => c.health > 0);
  if (activeCandidates.length > 0) {
    // Probabilistic selection: calculate effective weights as health * weight pct
    const totalWeight = activeCandidates.reduce(
      (sum, c) => sum + c.health * (c.weight / 100),
      0
    );
    if (totalWeight > 0) {
      let rand = Math.random() * totalWeight;
      for (const c of activeCandidates) {
        const w = c.health * (c.weight / 100);
        rand -= w;
        if (rand <= 0) return c.id;
      }
    }
    // Fallback: choose highest health
    activeCandidates.sort((a, b) => b.health - a.health);
    return activeCandidates[0].id;
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
    const budget = getBudgetStats(model, id);
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
      dailyTokensUsed: budget.dailyUsage,
      dailyQuotaLimit: budget.dailyLimit,
      activeRequests: t.activeCount,
      queuedRequests: 0,
      rate429: t.totalRequests > 0 ? Math.round((t.total429s / t.totalRequests) * 100) : 0,
    };
  });
}

export function getRecentRateLimitEvents(): RateLimitEvent[] {
  return recentEvents;
}
