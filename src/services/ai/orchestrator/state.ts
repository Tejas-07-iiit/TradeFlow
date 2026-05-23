/**
 * AI Orchestrator state and load balancer.
 *
 * Tracks the live load, rate limit events, and cooldowns for all configured
 * Groq API keys, allowing the scheduler to route jobs intelligently.
 */

import { modelCooldownRemainingMs, markModelCooldown, getBudgetStats } from "../providers/token-budget";
import type { KeyLoadStats, RateLimitEvent, AdminSettings, ModelCapability } from "./types";

interface RequestEvent {
  timestamp: number;
  tokens: number;
}

// Global process-wide admin settings with defaults.
const adminSettings: AdminSettings = {
  pausedModels: [],
  quarantinedPairs: [],
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
    mid: 2,
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

export const MODEL_CAPABILITIES: Record<string, ModelCapability> = {
  // Every Groq model in this list supports `response_format: json_object`
  // server-side enforcement. Marking any of them `supportsJson: false`
  // forces the pipeline to reroute to a heavier model and was the root
  // cause of the cooldown-cascade on llama-3.3-70b-versatile.
  "llama-3.3-70b-versatile":                   { id: "llama-3.3-70b-versatile",                   tier: "premium",     supportsJson: true, supportsReasoning: true,  supportsFastInference: false, avgLatencyMs: 1500 },
  "openai/gpt-oss-120b":                       { id: "openai/gpt-oss-120b",                       tier: "premium",     supportsJson: true, supportsReasoning: true,  supportsFastInference: false, avgLatencyMs: 2000 },
  "qwen/qwen3-32b":                            { id: "qwen/qwen3-32b",                            tier: "mid",         supportsJson: true, supportsReasoning: true,  supportsFastInference: false, avgLatencyMs: 800  },
  "openai/gpt-oss-20b":                        { id: "openai/gpt-oss-20b",                        tier: "mid",         supportsJson: true, supportsReasoning: true,  supportsFastInference: true,  avgLatencyMs: 500  },
  "llama-3.1-8b-instant":                      { id: "llama-3.1-8b-instant",                      tier: "lightweight", supportsJson: true, supportsReasoning: false, supportsFastInference: true,  avgLatencyMs: 300  },
  "meta-llama/llama-4-scout-17b-16e-instruct": { id: "meta-llama/llama-4-scout-17b-16e-instruct", tier: "lightweight", supportsJson: true, supportsReasoning: false, supportsFastInference: true,  avgLatencyMs: 400  },
};

export function getModelCapability(modelName: string): ModelCapability {
  // Try to match known capabilities by substring to support variant names
  const lower = modelName.toLowerCase();
  for (const [key, cap] of Object.entries(MODEL_CAPABILITIES)) {
    if (lower.includes(key.toLowerCase()) || lower.includes(key.split("/").pop()!)) {
      return cap;
    }
  }
  // Default fallback: assume the model is JSON-capable. Unknown models
  // shouldn't trigger the reroute-to-premium fallback by default — that's
  // what caused the production cooldown cascade. If a model genuinely
  // can't do JSON, the call will fail and the regular retry/cooldown
  // path will handle it.
  return { id: modelName, tier: "mid", supportsJson: true, supportsReasoning: true, supportsFastInference: false, avgLatencyMs: 1000 };
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
  
  // Model-level rolling metrics
  modelFailures: Record<string, number[]> = {};
  modelSuccesses: Record<string, number[]> = {};
  modelJsonFailures: Record<string, number[]> = {};

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
    const pairKey = `groq#${this.id}+${model}`;
    if (adminSettings.quarantinedPairs.includes(pairKey)) {
      return 0; // Quarantined
    }
    if (adminSettings.pausedModels.includes(model)) {
      return 0;
    }
    if (adminSettings.disabledAccounts.includes(this.id)) {
      return 0;
    }

    // Only the (model, account) cooldown blocks routing — a 429 on
    // gpt-oss-20b#2 must NOT lock out llama-3.3-70b-versatile#2. The
    // account-level `cooldownUntil` is informational only (kept for
    // logs / health-stats display).
    const cdRemaining = modelCooldownRemainingMs(model, this.id);
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

    // Apply Rolling Success Modifier
    const nowMs = Date.now();
    const recentSuccesses = (this.modelSuccesses[model] || []).filter(t => nowMs - t < 300000).length;
    const recentFailures = (this.modelFailures[model] || []).filter(t => nowMs - t < 300000).length;
    const recentJsonFailures = (this.modelJsonFailures[model] || []).filter(t => nowMs - t < 300000).length;
    
    // Circuit breaker check: 5 recent failures or 3 json failures trips circuit breaker
    if (recentFailures >= 5 || recentJsonFailures >= 3 || this.recent429s >= 5) {
      // Auto-quarantine the pair if circuit breaker trips
      const pairKey = `groq#${this.id}+${model}`;
      if (!adminSettings.quarantinedPairs.includes(pairKey)) {
        console.warn(`[orch/circuit-breaker] Tripped for ${pairKey}! Quarantining pair.`);
        adminSettings.quarantinedPairs.push(pairKey);
      }
      return 0;
    }
    
    // Boost score for high success rate, penalize for failures
    const totalRuns = recentSuccesses + recentFailures;
    if (totalRuns > 0) {
      const successRate = recentSuccesses / totalRuns;
      if (successRate > 0.9) score += 10;
      else if (successRate < 0.5) score -= 30;
      else score -= (1.0 - successRate) * 20;
    }
    
    return Math.max(0, Math.min(100, Math.round(score)));
  }

  getStatus(model: string): "healthy" | "cooldown" | "exhausted" {
    const pairKey = `groq#${this.id}+${model}`;
    if (adminSettings.quarantinedPairs.includes(pairKey)) {
      return "exhausted";
    }
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
    // Per-(model, account) cooldown only — see comment in getHealthScore.
    const cdRemaining = modelCooldownRemainingMs(model, this.id);
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
export function selectBestKey(model: string): number | undefined {
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

  // FAIL-FAST: Return undefined if no keys are healthy. 
  // We do NOT want to return an exhausted account and freeze the pipeline.
  return undefined;
}

export function recordRequestStart(accountId: number, estimatedTokens: number) {
  const tracker = getTracker(accountId);
  tracker.addEvent(estimatedTokens);
}

export function recordRequestEnd(accountId: number, model: string, durationMs: number, actualTokens?: number, success: boolean = true) {
  const tracker = getTracker(accountId);
  tracker.recordEnd(durationMs, actualTokens);
  
  if (success) {
    if (!tracker.modelSuccesses[model]) tracker.modelSuccesses[model] = [];
    tracker.modelSuccesses[model].push(Date.now());
  }
}

export function recordRequestFailure(accountId: number, model: string, isJsonError: boolean = false) {
  const tracker = getTracker(accountId);
  tracker.recordFailure();
  
  if (!tracker.modelFailures[model]) tracker.modelFailures[model] = [];
  tracker.modelFailures[model].push(Date.now());
  
  if (isJsonError) {
    if (!tracker.modelJsonFailures[model]) tracker.modelJsonFailures[model] = [];
    tracker.modelJsonFailures[model].push(Date.now());
  }
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
  markModelCooldown(model, retryAfterSec, accountId, isTpd);

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
    // Per-(model, account) cooldown is the authoritative routing signal —
    // see getHealthScore. Surfacing only this in the stats keeps heartbeat
    // logs consistent with what selectBestKey actually does.
    const cd = modelCooldownRemainingMs(model, id);
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
