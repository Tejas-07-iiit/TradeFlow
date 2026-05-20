/**
 * Scheduler — owns the global LLM concurrency budget.
 *
 * Why concurrency cap = 2? With 5 watchlist symbols on a 96s round-robin
 * plus on-demand triggers + thesis traffic, the system naturally produces
 * bursts. A hard cap of 2 in-flight LLM jobs has three benefits:
 *   1. We never push more than 2 parallel calls at a provider — the local
 *      token-bucket reservations remain accurate (vs. N parallel calls
 *      racing the budget check).
 *   2. Two slots are enough that EXEC_CRITICAL work and a routine scan
 *      can both progress; the next-prio job lands in the slot the first
 *      one vacates.
 *   3. Two slots give the priority queue meaningful work to do — with a
 *      cap of 8 there's never queue depth and priorities don't matter.
 *
 * The scheduler does NOT itself reserve tokens or call providers. It
 * dispatches `execute(job)`; the pipeline owns provider concerns. Keeping
 * scheduling separate from execution makes both testable in isolation.
 */

import { PriorityQueue, type QueueEntry } from "./queue";
import type { AnalysisJob, JobResult, OrchestratorStats } from "./types";

const MAX_CONCURRENT = 2;

export class Scheduler {
  private queue = new PriorityQueue();
  private activeCount = 0;
  private totalDispatched = 0;
  private totalAborted = 0;

  constructor(
    private readonly execute: (job: AnalysisJob) => Promise<JobResult>,
  ) {}

  /**
   * Submit a job. The returned promise settles when the job completes
   * (success), is expired by the queue (`source: "expired"`), or is
   * aborted by the caller (`source: "aborted"`).
   */
  submit(job: AnalysisJob): Promise<JobResult> {
    return new Promise<JobResult>((resolve, reject) => {
      const entry: QueueEntry = { job, resolve, reject };

      // If the caller's AbortSignal fires while we're still queued,
      // unhook us cleanly rather than letting the worker run a doomed job.
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
   * Drain the queue up to the concurrency cap. Called whenever we enqueue
   * and whenever a worker settles. Workers don't loop themselves — they
   * call `tick()` on completion which is the cheapest way to chain.
   */
  private tick(): void {
    while (this.activeCount < MAX_CONCURRENT) {
      const entry = this.queue.shift();
      if (!entry) return;
      this.activeCount++;
      this.totalDispatched++;
      const startedAt = Date.now();

      this.execute(entry.job)
        .then((result) => {
          entry.resolve({
            ...result,
            durationMs: result.durationMs || Date.now() - startedAt,
          });
        })
        .catch((err) => {
          // The pipeline shouldn't throw — it should return a JobResult
          // with ok:false. Catch anyway so a thrown pipeline doesn't
          // wedge the scheduler.
          const message = err instanceof Error ? err.message : String(err);
          entry.resolve({
            ok: false,
            error: `Pipeline crashed: ${message}`,
            durationMs: Date.now() - startedAt,
          });
        })
        .finally(() => {
          this.activeCount--;
          this.tick();
        });
    }
  }

  stats(extras: { inFlightKeys: string[] }): OrchestratorStats {
    return {
      queued: this.queue.size(),
      active: this.activeCount,
      byPriority: this.queue.countByPriority(),
      inFlightKeys: extras.inFlightKeys,
      totalDispatched: this.totalDispatched,
      totalExpired: this.queue.expiredCount,
      totalAborted: this.totalAborted,
    };
  }
}
