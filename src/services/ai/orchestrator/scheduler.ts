/**
 * Scheduler — owns the global LLM concurrency budget and pacing.
 */

import { PriorityQueue, type QueueEntry } from "./queue";
import type { AnalysisJob, JobResult, OrchestratorStats } from "./types";
import { getLiveKeysStats, getRecentRateLimitEvents } from "./state";

const MAX_CONCURRENT = process.env.AI_ORCH_MAX_CONCURRENT
  ? parseInt(process.env.AI_ORCH_MAX_CONCURRENT, 10)
  : 1;

const PACING_DELAY_MS = process.env.AI_ORCH_PACING_MS
  ? parseInt(process.env.AI_ORCH_PACING_MS, 10)
  : 2000;

export class Scheduler {
  private queue = new PriorityQueue();
  private activeCount = 0;
  private totalDispatched = 0;
  private totalAborted = 0;
  private totalRetries = 0;
  private lastDispatchTime = 0;
  private pacingTimer: NodeJS.Timeout | null = null;

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
   * Drain the queue up to the concurrency cap, respecting pacing.
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

    while (this.activeCount < MAX_CONCURRENT) {
      const entry = this.queue.shift();
      if (!entry) return;

      this.activeCount++;
      this.totalDispatched++;
      this.lastDispatchTime = Date.now();
      const startedAt = Date.now();

      // Trigger the execution
      this.execute(entry.job, this)
        .then((result) => {
          if (result.isTransient && entry.job.attempt < 5 && entry.job.expiresAt > Date.now()) {
            this.activeCount--;
            this.reEnqueue(entry);
            this.tick();
          } else {
            entry.resolve({
              ...result,
              durationMs: result.durationMs || Date.now() - startedAt,
            });
            this.activeCount--;
            this.tick();
          }
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          entry.resolve({
            ok: false,
            error: `Pipeline crashed: ${message}`,
            durationMs: Date.now() - startedAt,
          });
          this.activeCount--;
          this.tick();
        })
        .finally(() => {
          // pacing is handled on tick start via timeSinceLast
        });

      // Break loop to enforce pacing delay for next tick if MAX_CONCURRENT > 1
      if (MAX_CONCURRENT > 1) {
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

    return {
      queued: this.queue.size(),
      active: this.activeCount,
      byPriority: this.queue.countByPriority(),
      inFlightKeys: extras.inFlightKeys,
      totalDispatched: this.totalDispatched,
      totalExpired: this.queue.expiredCount,
      totalAborted: this.totalAborted,
      totalRetries: this.totalRetries,
      keys: getLiveKeysStats(extras.model || defaultModel),
      recentEvents: getRecentRateLimitEvents(),
    };
  }
}

