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

const ENDPOINT = "https://www.reddit.com/r/CryptoCurrency/hot.json?limit=30";
const USER_AGENT = "tradeflow:news-widget:1.0 (paper-trading simulator)";
const TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5_000;

let cache: { value: RedditPost[]; expiresAt: number } | null = null;

export async function getRedditHot(): Promise<RedditPost[]> {
  if (cache && cache.expiresAt > Date.now()) return cache.value;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: controller.signal,
      next: { revalidate: 300 },
    });
    if (!res.ok) return cache?.value ?? [];
    const json = (await res.json()) as RedditListing;
    const rows = json.data?.children ?? [];
    const posts: RedditPost[] = rows
      .map((r) => r.data)
      .filter((d): d is NonNullable<typeof d> => !!d && !d.over_18)
      // Drop the pinned/moderator posts that always sit at the top of /hot.
      .filter((d) => !d.stickied)
      .map((d) => ({
        id: d.id,
        title: d.title,
        score: d.score,
        numComments: d.num_comments,
        createdAt: d.created_utc,
        flair: d.link_flair_text,
        selftext: (d.selftext ?? "").slice(0, 400),
        permalink: `https://reddit.com${d.permalink}`,
        url: d.url,
        isStickied: !!d.stickied,
      }));

    cache = { value: posts, expiresAt: Date.now() + TTL_MS };
    return posts;
  } catch {
    return cache?.value ?? [];
  } finally {
    clearTimeout(timer);
  }
}
