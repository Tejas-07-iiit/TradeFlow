/**
 * Priority queue with expiration.
 *
 * Six buckets keyed by `JobPriority` value (0 = highest). Inside each
 * bucket, entries are FIFO so a long-waiting routine scan still gets a
 * chance once higher-priority work clears.
 *
 * Expiration is lazy — we don't run a sweep timer (extra wakeups in
 * Node), we just drop stale entries when `shift()` walks the bucket.
 * The "leaks" between sweeps are bounded by `enqueue` rejecting jobs
 * that arrive already past `expiresAt`.
 */

import { JobPriority, type AnalysisJob, type JobResult } from "./types";

export interface QueueEntry {
  job: AnalysisJob;
  resolve: (result: JobResult) => void;
  reject: (error: unknown) => void;
}

export class PriorityQueue {
  private buckets: Map<JobPriority, QueueEntry[]> = new Map();
  /** Cumulative count of jobs dropped because their SLA elapsed. */
  expiredCount = 0;

  enqueue(entry: QueueEntry): void {
    if (entry.job.expiresAt <= Date.now()) {
      this.expiredCount++;
      entry.resolve({
        ok: false,
        error: "Job already past SLA at enqueue time",
        source: "expired",
        durationMs: Date.now() - entry.job.enqueuedAt,
      });
      return;
    }
    const bucket = this.buckets.get(entry.job.priority) ?? [];
    bucket.push(entry);
    this.buckets.set(entry.job.priority, bucket);
  }

  /**
   * Pop the highest-priority, oldest non-expired job. Expired entries
   * encountered along the way are resolved with `source: "expired"` so
   * their submitters unblock cleanly.
   */
  shift(): QueueEntry | undefined {
    const priorities = [...this.buckets.keys()].sort((a, b) => a - b);
    const now = Date.now();
    for (const p of priorities) {
      const bucket = this.buckets.get(p);
      if (!bucket || bucket.length === 0) continue;
      while (bucket.length > 0 && bucket[0].job.expiresAt <= now) {
        const stale = bucket.shift()!;
        this.expiredCount++;
        stale.resolve({
          ok: false,
          error: `Job expired in queue (priority ${p})`,
          source: "expired",
          durationMs: now - stale.job.enqueuedAt,
        });
      }
      if (bucket.length > 0) return bucket.shift();
    }
    return undefined;
  }

  /**
   * Drop a queued job by dedup key (e.g. caller aborted). Returns true
   * if a match was found and removed.
   */
  removeByKey(dedupKey: string, reason: string): boolean {
    for (const bucket of this.buckets.values()) {
      const idx = bucket.findIndex((e) => e.job.dedupKey === dedupKey);
      if (idx >= 0) {
        const removed = bucket.splice(idx, 1)[0];
        removed.resolve({
          ok: false,
          error: reason,
          source: "aborted",
          durationMs: Date.now() - removed.job.enqueuedAt,
        });
        return true;
      }
    }
    return false;
  }

  size(): number {
    let total = 0;
    for (const bucket of this.buckets.values()) total += bucket.length;
    return total;
  }

  countByPriority(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [p, bucket] of this.buckets) {
      if (bucket.length > 0) out[String(p)] = bucket.length;
    }
    return out;
  }
}
