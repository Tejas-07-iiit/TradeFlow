/**
 * Robust RSS/XML regex parser and lightweight sentiment analyzer.
 * No external dependencies, completely safe for datacenter IPs.
 */

const POSITIVE_KEYWORDS = new Set([
  "up", "surge", "gain", "rise", "growth", "bullish", "high", "green", "buy", 
  "profit", "record", "success", "win", "support", "rally", "soar", "pump",
  "approval", "adopt", "upgrade", "breakout", "positive", "strong"
]);

const NEGATIVE_KEYWORDS = new Set([
  "down", "drop", "fall", "loss", "decline", "bearish", "low", "red", "sell", 
  "crash", "dump", "fail", "resistance", "hack", "scam", "risk", "warn", 
  "investigate", "fined", "sec", "lawsuit", "ban", "crackdown", "plunge",
  "negative", "weak", "concern", "fears"
]);

/**
 * Strips HTML tags and unescapes common HTML entities.
 */
export function unescapeHtml(html: string): string {
  if (!html) return "";
  return html
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1") // Extract CDATA content first
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/<\/?[^>]+(>|$)/g, "") // Strip all other HTML tags
    .trim();
}

/**
 * Extracts inner content of a tag.
 */
export function extractTagContent(xmlText: string, tagName: string): string {
  const match = new RegExp(`<${tagName}(?:[^>]*)>([\\s\\S]*?)<\/${tagName}>`, 'i').exec(xmlText);
  if (!match) return "";
  let val = match[1].trim();
  if (val.startsWith("<![CDATA[") && val.endsWith("]]>")) {
    val = val.substring(9, val.length - 3).trim();
  }
  return val;
}

/**
 * Extracts all items/entries of a specific node name from the feed XML.
 */
export function extractItems(xmlText: string, nodeName: string): string[] {
  const items: string[] = [];
  const regex = new RegExp(`<${nodeName}(?:[^>]*)>([\\s\\S]*?)<\/${nodeName}>`, 'gi');
  let match;
  while ((match = regex.exec(xmlText)) !== null) {
    items.push(match[1]);
  }
  return items;
}

/**
 * Extracts the href attribute of the first link tag.
 */
export function extractLinkHref(xmlText: string): string {
  const match = /<link\s+[^>]*href=["']([^"']+)["']/i.exec(xmlText);
  if (match) return match[1];
  return extractTagContent(xmlText, "link");
}

/**
 * Extracts media or image URL from tags like media:content, enclosure, etc.
 */
export function extractMediaUrl(xmlText: string): string {
  const matchMedia = /<(?:media:content|enclosure)\s+[^>]*url=["']([^"']+)["']/i.exec(xmlText);
  if (matchMedia) return matchMedia[1];
  
  const matchThumb = /<media:thumbnail\s+[^>]*url=["']([^"']+)["']/i.exec(xmlText);
  if (matchThumb) return matchThumb[1];
  
  const matchImg = /<img\s+[^>]*src=["']([^"']+)["']/i.exec(xmlText);
  if (matchImg) return matchImg[1];
  
  return "";
}

/**
 * Analyzes word frequencies to determine a sentiment score between -1 and 1.
 */
export function analyzeSentiment(text: string): number {
  if (!text) return 0;
  const words = text.toLowerCase().split(/[^a-zA-Z]+/);
  let pos = 0;
  let neg = 0;
  for (const w of words) {
    if (POSITIVE_KEYWORDS.has(w)) pos++;
    else if (NEGATIVE_KEYWORDS.has(w)) neg++;
  }
  const total = pos + neg;
  return total > 0 ? (pos - neg) / total : 0;
}
