import fs from "fs/promises";
import path from "path";
import type { NewsFeed } from "./index";

const STORE_PATH = path.join(process.cwd(), "src/services/news/news-store.json");

/**
 * Persists the aggregated news feed to a local JSON file.
 */
export async function saveNewsToStore(feed: NewsFeed): Promise<void> {
  try {
    await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
    await fs.writeFile(STORE_PATH, JSON.stringify(feed, null, 2), "utf-8");
  } catch (err) {
    console.error("[news-store] Failed to save news to store:", err);
  }
}

/**
 * Loads the aggregated news feed from the local JSON file.
 * Returns null if the file does not exist or fails to parse.
 */
export async function loadNewsFromStore(): Promise<NewsFeed | null> {
  try {
    const data = await fs.readFile(STORE_PATH, "utf-8");
    return JSON.parse(data) as NewsFeed;
  } catch (err: any) {
    if (err.code !== "ENOENT") {
      console.error("[news-store] Failed to load news from store:", err);
    }
    return null;
  }
}
