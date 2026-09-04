import { cacheKey, cacheGet, cacheSet } from "../db.js";

const GAMMA = "https://gamma-api.polymarket.com";

export interface TrendingMarket {
  question: string;
  slug: string;
  eventTitle: string;
  yes_price: number;
  chg_24h: number | null;
  volume_24h: number;
  volume_total: number;
  // derived signals
  conviction: number; // how decisive the favorite is, 0..0.5 (0.5 = near-certain)
  momentum: number; // abs 24h odds move
}

interface GammaMarket {
  question?: string;
  slug?: string;
  outcomePrices?: string;
  volume24hr?: number;
  volumeNum?: number;
  oneDayPriceChange?: number;
  active?: boolean;
  closed?: boolean;
  events?: Array<{ title?: string }>;
}

/**
 * The day's highest-activity active markets, with conviction + momentum signals
 * derived for pick ranking. Cached like every external call.
 */
export async function trendingMarkets(limit = 40): Promise<TrendingMarket[] | null> {
  const key = cacheKey("polymarket:trending", { limit });
  const hit = cacheGet<TrendingMarket[]>(key);
  if (hit !== undefined) return hit;
  try {
    const res = await fetch(
      `${GAMMA}/markets?closed=false&active=true&order=volume24hr&ascending=false&limit=${limit}`,
      { signal: AbortSignal.timeout(12_000) }
    );
    if (!res.ok) return null;
    const raw = (await res.json()) as GammaMarket[];
    const markets: TrendingMarket[] = (Array.isArray(raw) ? raw : [])
      .filter((m) => m.active && !m.closed && m.outcomePrices)
      .map((m) => {
        const yes = Number(JSON.parse(m.outcomePrices ?? "[0]")[0] ?? 0);
        const chg = typeof m.oneDayPriceChange === "number" ? m.oneDayPriceChange : null;
        return {
          question: m.question ?? "",
          slug: m.slug ?? "",
          eventTitle: m.events?.[0]?.title ?? "",
          yes_price: yes,
          chg_24h: chg,
          volume_24h: Math.round(m.volume24hr ?? 0),
          volume_total: Math.round(m.volumeNum ?? 0),
          conviction: Math.abs(yes - 0.5),
          momentum: chg === null ? 0 : Math.abs(chg),
        };
      });
    cacheSet(key, markets);
    return markets;
  } catch (err) {
    console.error(`polymarket trending: ${err}`);
    return null;
  }
}
