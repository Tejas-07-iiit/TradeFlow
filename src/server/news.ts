"use server";

import { getNewsFeed, type NewsFeed } from "@/services/news";

export interface NewsFeedResponse {
  ok: boolean;
  feed?: NewsFeed;
  error?: string;
}

/**
 * Server action: fetch the aggregated news feed.
 *
 * Returns `{ ok: true, feed }` even if individual sources fail — the
 * aggregator surfaces partial results rather than throwing. `ok: false`
 * only fires on a top-level unexpected error.
 */
export async function fetchNewsFeed(): Promise<NewsFeedResponse> {
  try {
    const feed = await getNewsFeed();
    return { ok: true, feed };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Unknown news error",
    };
  }
}
