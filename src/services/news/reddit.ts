/**
 * Reddit r/CryptoCurrency — "what people are talking about right now".
 *
 * Public read access, no auth. If JSON endpoints fail (such as HTTP 403 blocks
 * on cloud providers like AWS/GCP), this falls back to fetching the public
 * RSS feed which is typically not blocked.
 */

import { 
  extractItems, 
  extractTagContent, 
  extractLinkHref, 
  unescapeHtml, 
  analyzeSentiment 
} from "./rss-parser";

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
 * Reddit requires a descriptive User-Agent for API access.
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
 * Fetch and parse Reddit's public RSS feed.
 */
async function fetchRedditRss(): Promise<RedditPost[]> {
  try {
    const res = await fetch("https://www.reddit.com/r/CryptoCurrency/hot.rss", {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "application/xml, text/xml, */*"
      },
      next: { revalidate: 300 }
    });
    if (!res.ok) {
      console.warn(`[news/reddit-rss] Failed to fetch Reddit RSS: HTTP ${res.status}`);
      return [];
    }
    const xml = await res.text();
    const entries = extractItems(xml, "entry");
    
    return entries.map((entryXml) => {
      const idTag = extractTagContent(entryXml, "id");
      // id tag usually looks like "t3_1tiigu5" or similar
      const id = idTag.includes("_") ? idTag.split("_")[1] : idTag || Math.random().toString(36).substring(7);
      
      const title = unescapeHtml(extractTagContent(entryXml, "title"));
      const permalink = extractLinkHref(entryXml).trim();
      const contentHtml = extractTagContent(entryXml, "content");
      const selftext = unescapeHtml(contentHtml).slice(0, 400);
      
      const updatedStr = extractTagContent(entryXml, "updated");
      const createdAt = updatedStr ? Math.floor(Date.parse(updatedStr) / 1000) : Math.floor(Date.now() / 1000);
      
      // Calculate sentiment-based score & flair
      const sentiment = analyzeSentiment(`${title} ${selftext}`);
      let flair = "DISCUSSION";
      if (sentiment > 0.3) {
        flair = "BULLISH";
      } else if (sentiment < -0.3) {
        flair = "BEARISH";
      } else {
        const lower = `${title} ${selftext}`.toLowerCase();
        if (lower.includes("news")) flair = "NEWS";
        else if (lower.includes("advice") || lower.includes("help") || lower.includes("how to")) flair = "ADVICE";
        else if (lower.includes("analysis") || lower.includes("chart") || lower.includes("technical")) flair = "ANALYSIS";
      }
      
      return {
        id,
        title,
        score: Math.max(1, Math.round(50 + sentiment * 50)),
        numComments: 0,
        createdAt,
        flair,
        selftext,
        permalink,
        url: permalink,
        isStickied: false
      };
    });
  } catch (err) {
    console.warn(`[news/reddit-rss] Error fetching/parsing Reddit RSS:`, err);
    return [];
  }
}

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
  console.warn(`[news/reddit] all JSON endpoints failed: ${combined} — attempting RSS fallback`);
  
  try {
    const rssPosts = await fetchRedditRss();
    if (rssPosts.length > 0) {
      cache = { value: rssPosts, expiresAt: Date.now() + TTL_MS };
      return { posts: rssPosts };
    }
  } catch (rssErr) {
    console.warn(`[news/reddit] RSS fallback failed: ${rssErr}`);
  }

  if (cache) return { posts: cache.value, error: combined, stale: true };
  return { posts: [], error: combined };
}

/** Backwards-compatible shim — drop when no callers reference it. */
export async function getRedditHot(): Promise<RedditPost[]> {
  return (await getRedditHotDetailed()).posts;
}
