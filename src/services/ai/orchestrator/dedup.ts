/**
 * In-flight job dedup.
 *
 * When two callers submit the same logical work (same `dedupKey`),
 * we want them to share one execution — both subscribers get the same
 * answer for the cost of one LLM call.
 *
 * This sits ON TOP of the existing decision cache in
 * `market-decision.ts`. The cache covers same-fingerprint requests that
 * arrive far apart in time; this map covers same-fingerprint requests
 * that arrive concurrently (cache miss + race condition).
 */

import type { JobResult } from "./types";

const inFlight = new Map<string, Promise<JobResult>>();

export function findInFlight(key: string): Promise<JobResult> | undefined {
  return inFlight.get(key);
}

export function trackInFlight(
  key: string,
  promise: Promise<JobResult>,
): Promise<JobResult> {
  inFlight.set(key, promise);
  promise
    .catch(() => {
      // swallow — the consumer's `then` chain will see the error.
    })
    .finally(() => {
      if (inFlight.get(key) === promise) inFlight.delete(key);
    });
  return promise;
}

export function inFlightKeys(): string[] {
  return [...inFlight.keys()];
}

export function inFlightSize(): number {
  return inFlight.size;
}
