import { cacheKey, cacheGet, cacheSet } from "../db.js";
import type { BudgetGuard } from "../pipeline/budget.js";
import type { PredictionVenue } from "../types.js";

// Prediction markets on a company, straight from Polymarket's public search —
// no model in the loop. Optic's general prediction lens asks a model for
// keywords first; the desk resolves the company deterministically, so it can
// search by name and skip that call (and its failure mode when no key is set).
const UA = "Mozilla/5.0 (compatible; optic-bitget/1.0)";
const TIMEOUT_MS = 10_000;
const TTL_S = 5 * 60;

interface SearchResult {
  events?: Array<{
    title?: string;
    slug?: string;
    endDate?: string;
    markets?: Array<{ question?: string; outcomePrices?: string; outcomes?: string; volumeNum?: number; volume?: string; oneDayPriceChange?: number; closed?: boolean; slug?: string }>;
  }>;
}

export async function companyMarkets(company: string, ticker: string, budget?: BudgetGuard): Promise<PredictionVenue | null> {
  const q = company.length > 2 ? company : ticker;
  const url = `https://gamma-api.polymarket.com/public-search?q=${encodeURIComponent(q)}&limit_per_type=8`;
  const key = cacheKey("polymarket:search", url);
  const hit = cacheGet<PredictionVenue | null>(key);
  if (hit !== undefined) return hit;
  budget?.register("polymarket:search", 0);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { "User-Agent": UA, Accept: "application/json" } });
    if (!res.ok) return null;
    const json = (await res.json()) as SearchResult;
    const want = [company.toLowerCase(), ticker.toLowerCase()];
    const markets: PredictionVenue["markets"] = [];
    for (const ev of json.events ?? []) {
      for (const m of ev.markets ?? []) {
        if (m.closed) continue;
        const text = `${ev.title ?? ""} ${m.question ?? ""}`.toLowerCase();
        if (!want.some((w) => text.includes(w))) continue; // the search is fuzzy; keep only markets that name the company
        let yes: number | null = null;
        try {
          const prices = JSON.parse(m.outcomePrices ?? "[]") as string[];
          const outcomes = JSON.parse(m.outcomes ?? "[]") as string[];
          const i = outcomes.findIndex((o) => /^(yes|up)$/i.test(o));
          yes = parseFloat(prices[i >= 0 ? i : 0]);
        } catch {
          /* leave null */
        }
        if (yes === null || !Number.isFinite(yes)) continue;
        markets.push({
          question: m.question ?? ev.title ?? "",
          yes_price: Math.round(yes * 1000) / 1000,
          yes_chg_24h: typeof m.oneDayPriceChange === "number" ? Math.round(m.oneDayPriceChange * 1000) / 1000 : null,
          volume: m.volumeNum ?? (m.volume ? parseFloat(m.volume) : null),
          url: m.slug ? `https://polymarket.com/event/${ev.slug ?? m.slug}` : null,
          ends_at: ev.endDate ?? null,
        } as PredictionVenue["markets"][number]);
      }
    }
    markets.sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0));
    const venue = markets.length ? ({ markets: markets.slice(0, 6) } as PredictionVenue) : null;
    cacheSet(key, venue, TTL_S);
    return venue;
  } catch (err) {
    console.error(`polymarket search ${q}: ${err}`);
    return null;
  }
}
