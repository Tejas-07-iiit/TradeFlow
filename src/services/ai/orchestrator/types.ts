/**
 * Orchestrator types — the contract between event producers (subscribers,
 * server actions, event sources) and the scheduler / pipeline.
 */

import type { CachedDecision } from "../reasoning/market-decision";
import type { CachedThesis } from "../reasoning/market-thesis";
import type { DecisionInput, ThesisInput } from "../schemas";

// News validation types copied/defined here to avoid circular imports.
export interface LlmClassifierItem {
  id: string;
  title: string;
  excerpt: string;
}

export interface LlmClassifierVerdict {
  id: string;
  class: string;
  confidence: string | number;
  reasoning: string;
}

/**
 * Priority levels, lowest number wins. Inside a bucket, jobs are FIFO.
 */
export enum JobPriority {
  EXECUTION_CRITICAL = 0,
  POSITION_MGMT = 1,
  ELITE_SETUP = 2,
  NEW_SETUP = 3,
  ROUTINE_SCAN = 4,
  RECHECK = 5,
}

export const PRIORITY_LABELS: Record<JobPriority, string> = {
  [JobPriority.EXECUTION_CRITICAL]: "EXEC_CRITICAL",
  [JobPriority.POSITION_MGMT]: "POSITION_MGMT",
  [JobPriority.ELITE_SETUP]: "ELITE_SETUP",
  [JobPriority.NEW_SETUP]: "NEW_SETUP",
  [JobPriority.ROUTINE_SCAN]: "ROUTINE_SCAN",
  [JobPriority.RECHECK]: "RECHECK",
};

export type JobKind = "decision" | "thesis" | "news";

/**
 * Per-priority SLA in ms. If a job hasn't been dispatched within this
 * window, it's dropped from the queue. Prevents stale work from running.
 */
export const PRIORITY_SLA_MS: Record<JobPriority, number> = {
  [JobPriority.EXECUTION_CRITICAL]: 30_000,
  [JobPriority.POSITION_MGMT]: 20_000,
  [JobPriority.ELITE_SETUP]: 25_000,
  [JobPriority.NEW_SETUP]: 20_000,
  [JobPriority.ROUTINE_SCAN]: 15_000,
  [JobPriority.RECHECK]: 10_000,
};

export interface DecisionJob {
  kind: "decision";
  symbol: string;
  timeframe: string;
  payload: DecisionInput;
  dedupKey: string;
  priority: JobPriority;
  enqueuedAt: number;
  expiresAt: number;
  abortSignal?: AbortSignal;
  attempt: number;
  runAfter: number;
  modelOverride?: string;
}

export interface ThesisJob {
  kind: "thesis";
  symbol: string;
  timeframe: string;
  payload: ThesisInput;
  dedupKey: string;
  priority: JobPriority;
  enqueuedAt: number;
  expiresAt: number;
  abortSignal?: AbortSignal;
  attempt: number;
  runAfter: number;
  modelOverride?: string;
}

export interface NewsJob {
  kind: "news";
  symbol: string;
  coinName: string;
  items: LlmClassifierItem[];
  dedupKey: string;
  priority: JobPriority;
  enqueuedAt: number;
  expiresAt: number;
  abortSignal?: AbortSignal;
  attempt: number;
  runAfter: number;
  modelOverride?: string;
}

export type AnalysisJob = DecisionJob | ThesisJob | NewsJob;

/**
 * Result type emitted by the pipeline.
 */
export interface JobResult {
  ok: boolean;
  decision?: CachedDecision;
  thesis?: CachedThesis;
  verdicts?: LlmClassifierVerdict[];
  error?: string;
  source?: "llm" | "prefilter" | "local-fallback" | "cache" | "expired" | "aborted";
  durationMs: number;
  isTransient?: boolean;
  /** When set, the scheduler MUST NOT requeue this job even if isTransient
   *  is true — set by the pipeline when every model is in cooldown so we
   *  fall through to local fallback instead of feeding the retry storm. */
  skipRetry?: boolean;
}

export type LlmModelTier = "premium" | "lightweight" | "background";

export interface ModelStats {
  modelName: string;
  health: "healthy" | "cooldown" | "exhausted";
  cooldownLeftMs: number;
  avgLatencyMs: number;
  queueDepth: number;
  successRate: number;
  failureRate: number;
  totalRequests: number;
  totalSuccess: number;
  totalFailures: number;
  total429s: number;
  rpm: number;
  tpm: number;
  dailyQuotaUsage: number;
  dailyQuotaLimit: number;
  fallbackCount: number;
  retryCount: number;
}

export interface SystemHealthStats {
  postgresStatus: "healthy" | "unhealthy";
  prismaPoolActive: number;
  websocketStatus: "connected" | "disconnected";
  memoryUsageMb: number;
  cpuUsagePct: number;
  serverLatencyMs: number;
  apiLatencyMs: number;
  pm2Status: string;
}

export interface AdminSettings {
  pausedModels: string[];
  disabledAccounts: number[];
  routingWeights: Record<string, number>;
  concurrencyLimits: Record<LlmModelTier, number>;
  aggressiveMode: boolean;
  lowTokenMode: boolean;
  emergencyStop: boolean;
  disablePremium: boolean;
  maintenanceMode: boolean;
}

export interface KeyLoadStats {
  accountId: number;
  activeCount: number;
  requestsLastMin: number;
  tokensLastMin: number;
  cooldownLeftMs: number;
  totalRequests: number;
  total429s: number;
  avgLatencyMs: number;
  healthScore: number;
  cooldownUntil: number;
  recent429s: number;
  status: "healthy" | "cooldown" | "exhausted";
  // Add new fields for admin/ops monitoring
  dailyTokensUsed: number;
  dailyQuotaLimit: number;
  activeRequests: number;
  queuedRequests: number;
  rate429: number;
}

export interface RateLimitEvent {
  timestamp: string;
  accountId: number;
  model: string;
  retryAfterSec: number;
  isTpd: boolean;
  message: string;
}

/**
 * Stats for observability + ops dashboards.
 */
export interface OrchestratorStats {
  queued: number;
  active: number;
  byPriority: Record<string, number>;
  inFlightKeys: string[];
  totalDispatched: number;
  totalExpired: number;
  totalAborted: number;
  totalRetries: number;
  keys: KeyLoadStats[];
  recentEvents: RateLimitEvent[];
  // Added for institutional ops dashboard
  activeByTier: Record<LlmModelTier, number>;
  tierLimits: Record<LlmModelTier, number>;
  models: ModelStats[];
  systemHealth: SystemHealthStats;
  adminSettings: AdminSettings;
}


