/**
 * Reddit r/CryptoCurrency — "what people are talking about right now".
 *
 * Endpoint: https://www.reddit.com/r/CryptoCurrency/hot.json
 * Public read access, no auth — but Reddit requires a sane User-Agent.
 * They will rate-limit (or 429) requests that look like default Node fetch.
 *
 * We cache for 5 minutes and soft-fail to the previous cache on errors.
 */

export interface RedditPost {
  id: string;
  title: string;
  /** Net upvote score (ups - downs). */
  score: number;
  numComments: number;
  /** Unix seconds. */
  createdAt: number;
  /** Flair text — often the post category ("DISCUSSION", "ANALYSIS", "NEWS"). */
  flair: string | null;
  /** Excerpt from the self-post body, or empty for link posts. */
  selftext: string;
  /** Permalink (Reddit-relative). */
  permalink: string;
  /** External URL if it's a link post; reddit.com URL for self-posts. */
  url: string;
  isStickied: boolean;
}

interface RedditListing {
  data?: {
    children?: Array<{
      data?: {
        id: string;
        title: string;
        score: number;
        num_comments: number;
        created_utc: number;
        link_flair_text: string | null;
        selftext?: string;
        permalink: string;
        url: string;
        stickied?: boolean;
        over_18?: boolean;
      };
    }>;
  };
}

/**
 * `www.reddit.com/.json` and `old.reddit.com/.json` aggressively block
 * data-center IPs (AWS, GCP, Azure). `api.reddit.com` is Reddit's
 * official API host and is far more tolerant of server-to-server calls
 * with a proper User-Agent. We try it first, then fall back.
 */
const ENDPOINTS = [
  "https://api.reddit.com/r/CryptoCurrency/hot?limit=30",
  "https://old.reddit.com/r/CryptoCurrency/hot.json?limit=30",
  "https://www.reddit.com/r/CryptoCurrency/hot.json?limit=30",
];
/**
 * Reddit requires a descriptive User-Agent for API access. Generic
 * "node-fetch" or empty UAs get 403/429 from all hosts. The Reddit
 * API docs recommend: `<platform>:<app ID>:<version> (by /u/<reddit username>)`
 */
const USER_AGENT =
  process.env.REDDIT_USER_AGENT?.trim() ||
  "linux:tradeflow:1.0.0 (by /u/tradeflow_bot)";
const TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8_000;

export interface RedditFetchResult {
  posts: RedditPost[];
  /** Populated when every endpoint failed and we returned cached/empty. */
  error?: string;
  /** True when we served from a stale cache because every endpoint failed. */
  stale?: boolean;
}

let cache: { value: RedditPost[]; expiresAt: number } | null = null;

/**
 * Detailed fetch — returns posts plus a diagnostic flag set so the
 * aggregator can show "Reddit blocked by upstream" in the UI.
 */
export async function getRedditHotDetailed(): Promise<RedditFetchResult> {
  if (cache && cache.expiresAt > Date.now()) return { posts: cache.value };

  const errors: string[] = [];
  for (const endpoint of ENDPOINTS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(endpoint, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/json",
        },
        signal: controller.signal,
        next: { revalidate: 300 },
      });
      if (!res.ok) {
        errors.push(`${new URL(endpoint).host} HTTP ${res.status}`);
        continue;
      }
      const json = (await res.json()) as RedditListing;
      const children = json.data?.children;
      // Validate shape — Reddit may return valid JSON that isn't the
      // expected listing structure (e.g. error pages, captchas).
      if (!children || !Array.isArray(children)) {
        errors.push(`${new URL(endpoint).host} unexpected response shape`);
        continue;
      }
      const posts: RedditPost[] = children
        .map((r) => r.data)
        .filter(
          (d): d is NonNullable<typeof d> =>
            d != null && typeof d.id === "string" && typeof d.title === "string" && !d.over_18,
        )
        .filter((d) => !d.stickied)
        .map((d) => ({
          id: d.id,
          title: d.title,
          score: d.score ?? 0,
          numComments: d.num_comments ?? 0,
          createdAt: d.created_utc ?? 0,
          flair: d.link_flair_text ?? null,
          selftext: (d.selftext ?? "").slice(0, 400),
          permalink: `https://reddit.com${d.permalink}`,
          url: d.url,
          isStickied: !!d.stickied,
        }));

      cache = { value: posts, expiresAt: Date.now() + TTL_MS };
      return { posts };
    } catch (err) {
      errors.push(
        `${new URL(endpoint).host} ${err instanceof Error ? err.message : "fetch error"}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  const combined = errors.join("; ");
  console.warn(`[news/reddit] all endpoints failed: ${combined}`);
  if (cache) return { posts: cache.value, error: combined, stale: true };
  return { posts: [], error: combined };
}

/** Backwards-compatible shim — drop when no callers reference it. */
export async function getRedditHot(): Promise<RedditPost[]> {
  return (await getRedditHotDetailed()).posts;
}
