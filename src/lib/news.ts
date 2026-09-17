import { cacheKey, cacheGet, cacheSet } from "../db.js";
import type { BudgetGuard } from "../pipeline/budget.js";

// Headlines — dated, linked, from two free feeds that answered every probe:
// Yahoo Finance's per-ticker RSS and Google News search RSS. No key, no model.
// A headline is evidence of WHAT was said and WHEN; the debate cites it by
// row, it never summarises it into a number.
const UA = "Mozilla/5.0 (compatible; optic-bitget/1.0)";
const TIMEOUT_MS = 10_000;
const TTL_S = 10 * 60;

export interface Headline {
  title: string;
  link: string | null;
  source: string | null;
  published_at: string | null; // ISO
  feed: "yahoo" | "google";
}

function parseRss(xml: string, feed: Headline["feed"]): Headline[] {
  const out: Headline[] = [];
  const items = xml.split(/<item[\s>]/).slice(1);
  for (const it of items) {
    const pick = (tag: string) => {
      const m = it.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`, "i"));
      return m ? m[1].trim() : null;
    };
    const title = pick("title");
    if (!title) continue;
    const pub = pick("pubDate");
    const d = pub ? new Date(pub) : null;
    // Google News appends " - Source" to titles and carries <source>.
    const src = pick("source") ?? (feed === "google" ? title.split(" - ").pop() ?? null : "Yahoo Finance");
    out.push({
      title: feed === "google" ? title.replace(/\s-\s[^-]+$/, "") : title,
      link: pick("link"),
      source: src,
      published_at: d && !Number.isNaN(d.getTime()) ? d.toISOString() : null,
      feed,
    });
  }
  return out;
}

async function fetchFeed(url: string, feed: Headline["feed"], endpoint: string, budget?: BudgetGuard): Promise<Headline[]> {
  const key = cacheKey(`news:${endpoint}`, url);
  const hit = cacheGet<Headline[]>(key);
  if (hit !== undefined) return hit;
  budget?.register(`news:${endpoint}`, 0);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { "User-Agent": UA, Accept: "application/rss+xml, application/xml, text/xml" } });
    if (!res.ok) {
      console.error(`news ${endpoint}: HTTP ${res.status}`);
      return [];
    }
    const items = parseRss(await res.text(), feed);
    cacheSet(key, items, TTL_S);
    return items;
  } catch (err) {
    console.error(`news ${endpoint}: ${err}`);
    return [];
  }
}

/** Recent headlines for a company, newest first, de-duplicated across feeds. */
export async function headlines(ticker: string, company: string, budget?: BudgetGuard, limit = 8): Promise<Headline[]> {
  const [y, g] = await Promise.all([
    fetchFeed(`https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(ticker)}&region=US&lang=en-US`, "yahoo", "yahoo_rss", budget),
    fetchFeed(`https://news.google.com/rss/search?q=${encodeURIComponent(`${company} stock`)}&hl=en-US&gl=US&ceid=US:en`, "google", "google_rss", budget),
  ]);
  const seen = new Set<string>();
  const all = [...y, ...g].filter((h) => {
    const k = h.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").slice(0, 60);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  all.sort((a, b) => (b.published_at ?? "").localeCompare(a.published_at ?? ""));
  return all.slice(0, limit);
}
