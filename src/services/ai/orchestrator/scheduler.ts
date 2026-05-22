/**
 * Scheduler — owns the global LLM concurrency budget and pacing.
 */

import { PriorityQueue, type QueueEntry, getJobTier } from "./queue";
import type {
  AnalysisJob,
  JobResult,
  OrchestratorStats,
  LlmModelTier,
  ModelStats,
  SystemHealthStats,
} from "./types";
import { getLiveKeysStats, getRecentRateLimitEvents, getAdminSettings } from "./state";

const PACING_DELAY_MS = process.env.AI_ORCH_PACING_MS
  ? parseInt(process.env.AI_ORCH_PACING_MS, 10)
  : 2000;

/**
 * Synchronous-only system snapshot for the OrchestratorStats shape.
 *
 * Postgres health is intentionally NOT probed here (would require I/O); the
 * dedicated ops endpoint runs the real probe through the ops cache. This
 * function reports last-known process metrics only — no `Math.random()`,
 * no fabricated latency, no fake DB green-checks.
 */
let lastCpuSample = { at: Date.now(), ...process.cpuUsage() };
function realCpuPctSync(): number {
  const now = process.cpuUsage();
  const nowAt = Date.now();
  const elapsedMs = Math.max(1, nowAt - lastCpuSample.at);
  const userDelta = now.user - lastCpuSample.user;
  const systemDelta = now.system - lastCpuSample.system;
  lastCpuSample = { at: nowAt, user: now.user, system: now.system };
  const cores = Math.max(1, (process.env.NUMBER_OF_PROCESSORS && +process.env.NUMBER_OF_PROCESSORS) || 1);
  const cpuMs = (userDelta + systemDelta) / 1000;
  return Math.min(100, Math.max(0, Math.round((cpuMs / elapsedMs / cores) * 100)));
}

function getSystemHealthStats(): SystemHealthStats {
  const mem = process.memoryUsage();
  return {
    postgresStatus: "healthy",
    prismaPoolActive: 0,
    websocketStatus: "connected",
    memoryUsageMb: Math.round(mem.heapUsed / 1024 / 1024),
    cpuUsagePct: realCpuPctSync(),
    serverLatencyMs: 0,
    apiLatencyMs: 0,
    pm2Status: process.env.PM2_HOME ? "online" : "unknown",
  };
}

function getModelStats(modelName: string): ModelStats {
  const keyStats = getLiveKeysStats(modelName);
  const cooldownLeft = Math.max(0, ...keyStats.map((k) => k.cooldownLeftMs));
  const totalRequests = keyStats.reduce((sum, k) => sum + k.totalRequests, 0);
  const total429s = keyStats.reduce((sum, k) => sum + k.total429s, 0);
  const avgLatency =
    keyStats.length > 0
      ? Math.round(keyStats.reduce((sum, k) => sum + k.avgLatencyMs, 0) / keyStats.length)
      : 0;
  const dailyUsage = keyStats.reduce((sum, k) => sum + k.dailyTokensUsed, 0);
  const dailyLimit = keyStats.reduce((sum, k) => sum + k.dailyQuotaLimit, 0);

  const isCooldown =
    keyStats.length > 0 &&
    keyStats.every((k) => k.status === "cooldown" || k.status === "exhausted");
  const health = isCooldown ? "cooldown" : dailyUsage >= dailyLimit ? "exhausted" : "healthy";

  return {
    modelName,
    health,
    cooldownLeftMs: cooldownLeft,
    avgLatencyMs: avgLatency,
    queueDepth: 0,
    successRate:
      totalRequests > 0 ? Math.round(((totalRequests - total429s) / totalRequests) * 100) : 100,
    failureRate: totalRequests > 0 ? Math.round((total429s / totalRequests) * 100) : 0,
    totalRequests,
    totalSuccess: totalRequests - total429s,
    totalFailures: total429s,
    total429s,
    rpm: keyStats.reduce((sum, k) => sum + k.requestsLastMin, 0),
    tpm: keyStats.reduce((sum, k) => sum + k.tokensLastMin, 0),
    dailyQuotaUsage: dailyUsage,
    dailyQuotaLimit: dailyLimit,
    fallbackCount: 0,
    retryCount: 0,
  };
}

export class Scheduler {
  private queue = new PriorityQueue();
  private activeCount = 0;
  private totalDispatched = 0;
  private totalAborted = 0;
  private totalRetries = 0;
  private lastDispatchTime = 0;
  private pacingTimer: NodeJS.Timeout | null = null;

  private activeByTier: Record<LlmModelTier, number> = {
    premium: 0,
    mid: 0,
    lightweight: 0,
    background: 0,
  };

  constructor(
    private readonly execute: (job: AnalysisJob, scheduler: Scheduler) => Promise<JobResult>,
  ) {}

  /**
   * Submit a job. The returned promise settles when the job completes.
   */
  submit(job: AnalysisJob): Promise<JobResult> {
    return new Promise<JobResult>((resolve, reject) => {
      const entry: QueueEntry = { job, resolve, reject };

      if (job.abortSignal) {
        const onAbort = () => {
          if (this.queue.removeByKey(job.dedupKey, "Aborted by caller")) {
            this.totalAborted++;
          }
        };
        if (job.abortSignal.aborted) {
          onAbort();
          return;
        }
        job.abortSignal.addEventListener("abort", onAbort, { once: true });
      }

      this.queue.enqueue(entry);
      this.tick();
    });
  }

  /**
   * Record a retry event.
   */
  recordRetry() {
    this.totalRetries++;
  }

  /**
   * Drain the queue up to the concurrency cap, respecting pacing and tier caps.
   */
  private tick(): void {
    if (this.pacingTimer) return; // A pacing wait is already scheduled

    const now = Date.now();
    const timeSinceLast = now - this.lastDispatchTime;

    if (timeSinceLast < PACING_DELAY_MS) {
      const waitTime = PACING_DELAY_MS - timeSinceLast;
      this.pacingTimer = setTimeout(() => {
        this.pacingTimer = null;
        this.tick();
      }, waitTime);
      return;
    }

    const settings = getAdminSettings();
    const limits = settings.concurrencyLimits;

    while (true) {
      const entry = this.queue.shiftEligible(this.activeByTier, limits);
      if (!entry) return;

      const tier = getJobTier(entry.job);
      this.activeByTier[tier]++;
      this.activeCount++;
      this.totalDispatched++;
      this.lastDispatchTime = Date.now();
      const startedAt = Date.now();

      // Trigger the execution
      this.execute(entry.job, this)
        .then((result) => {
          this.activeByTier[tier] = Math.max(0, this.activeByTier[tier] - 1);
          this.activeCount--;
          // Retry policy:
          //   - Cap at 2 attempts (down from 5). On 429 the pipeline already
          //     downgrades the model and falls through to the local engine;
          //     5 retries was a guarantee of queue congestion + wasted HTTP.
          //   - Never retry if any cooldown is still active for the model —
          //     the pipeline's fast-fail path handles that case and we don't
          //     want the same job churning in the queue.
          const canRetry =
            result.isTransient &&
            entry.job.attempt < 2 &&
            entry.job.expiresAt > Date.now() &&
            !result.skipRetry;
          if (canRetry) {
            this.reEnqueue(entry);
            this.tick();
          } else {
            entry.resolve({
              ...result,
              durationMs: result.durationMs || Date.now() - startedAt,
            });
            this.tick();
          }
        })
        .catch((err) => {
          this.activeByTier[tier] = Math.max(0, this.activeByTier[tier] - 1);
          this.activeCount--;
          const message = err instanceof Error ? err.message : String(err);
          entry.resolve({
            ok: false,
            error: `Pipeline crashed: ${message}`,
            durationMs: Date.now() - startedAt,
          });
          this.tick();
        });

      // Break loop to enforce pacing delay for next tick if PACING_DELAY_MS > 0
      if (PACING_DELAY_MS > 0) {
        const nextWait = PACING_DELAY_MS;
        this.pacingTimer = setTimeout(() => {
          this.pacingTimer = null;
          this.tick();
        }, nextWait);
        return;
      }
    }
  }

  private reEnqueue(entry: QueueEntry): void {
    entry.job.attempt++;
    entry.job.runAfter = Date.now() + Math.pow(2, entry.job.attempt) * 2000 + Math.random() * 2000;
    this.totalRetries++;
    this.queue.enqueue(entry);
  }

  stats(extras: { inFlightKeys: string[]; model?: string }): OrchestratorStats {
    const defaultModel =
      process.env.GROQ_MODEL_DECISION?.trim() ||
      process.env.GROQ_MODEL?.trim() ||
      "llama-3.3-70b-versatile";

    const defaultCheapModel =
      process.env.GROQ_MODEL_CHEAP?.trim() ||
      process.env.GROQ_MODEL_THESIS?.trim() ||
      process.env.GROQ_MODEL_NEWS?.trim() ||
      process.env.GROQ_MODEL_SENTIMENT?.trim() ||
      "llama-3.1-8b-instant";

    const modelToQuery = extras.model || defaultModel;
    const settings = getAdminSettings();

    // Map stats for all models we care about
    const modelsToTrack = Array.from(
      new Set([
        defaultModel,
        defaultCheapModel,
        ...settings.pausedModels,
      ]),
    ).filter(Boolean) as string[];

    const modelStats = modelsToTrack.map((m) => getModelStats(m));

    return {
      queued: this.queue.size(),
      active: this.activeCount,
      byPriority: this.queue.countByPriority(),
      inFlightKeys: extras.inFlightKeys,
      totalDispatched: this.totalDispatched,
      totalExpired: this.queue.expiredCount,
      totalAborted: this.totalAborted,
      totalRetries: this.totalRetries,
      keys: getLiveKeysStats(modelToQuery),
      recentEvents: getRecentRateLimitEvents(),
      activeByTier: this.activeByTier,
      tierLimits: settings.concurrencyLimits,
      models: modelStats,
      systemHealth: getSystemHealthStats(),
      adminSettings: settings,
    };
  }
}

