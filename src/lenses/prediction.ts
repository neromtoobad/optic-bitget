import type { Lens, PredictionVenue, Resolved } from "../types.js";
import { structuredCall } from "../lib/anthropic.js";
import { cacheKey, cacheGet, cacheSet } from "../db.js";
import { BudgetGuard } from "../pipeline/budget.js";
import { isCliEntry } from "../fixtures.js";
import { config } from "../config.js";

const GAMMA = "https://gamma-api.polymarket.com";
// Phase 0 finding: Gamma fuzzy-matches garbage queries with CLOSED markets.
// Relevance = open + volume floor + keyword hit. A wrong match is worse than null.
const VOLUME_FLOOR = 10_000;

const KEYWORDS_SCHEMA = {
  type: "object",
  properties: {
    keywords: {
      type: "array",
      items: { type: "string" },
      description:
        "0-4 search keywords for finding prediction markets about this subject. Include the MOST SPECIFIC named entities first (team names, people, tickers, place names) — e.g. 'spain vs portugal' → ['spain', 'portugal']; 'trump memecoin' → ['trump']; 'fed rate cut' → ['fed rate']. Do NOT generalise a specific matchup up to its tournament (never turn 'spain vs portugal' into 'world cup'). Short, concrete, no cashtags. EMPTY ARRAY only when the subject is a niche token with no plausible real-world outcome market.",
    },
    entities: {
      type: "array",
      items: { type: "string" },
      description:
        "The specific named entities the user is asking about, lowercased (e.g. ['spain','portugal'], ['trump'], ['bitcoin']). Used to rank markets by how directly they price the named subject. Empty if the query names no specific entity.",
    },
    winner_query: {
      type: "boolean",
      description:
        "TRUE when the user is asking who will WIN a multi-outcome contest with many possible winners — 'who wins the world cup', 'who will be the nominee', 'f1 champion', 'super bowl winner'. FALSE for a head-to-head ('spain vs portugal'), a yes/no ('will bitcoin hit 100k'), or a token/narrative.",
    },
  },
  required: ["keywords", "entities", "winner_query"],
  additionalProperties: false,
} as const;

interface GammaEvent {
  title?: string;
  markets?: Array<{
    question?: string;
    slug?: string;
    outcomePrices?: string;
    volumeNum?: number;
    oneDayPriceChange?: number;
    active?: boolean;
    closed?: boolean;
  }>;
}

async function searchGamma(query: string): Promise<GammaEvent[] | null> {
  const key = cacheKey("polymarket:search", query);
  const hit = cacheGet<GammaEvent[]>(key);
  if (hit !== undefined) return hit;
  try {
    const res = await fetch(`${GAMMA}/public-search?q=${encodeURIComponent(query)}&limit_per_type=8`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { events?: GammaEvent[] };
    const events = json.events ?? [];
    cacheSet(key, events);
    return events;
  } catch (err) {
    console.error(`polymarket search: ${err}`);
    return null;
  }
}

function toMarket(m: NonNullable<GammaEvent["markets"]>[number]) {
  return {
    question: m.question ?? "",
    venue: "polymarket",
    yes_price: Number(JSON.parse(m.outcomePrices ?? "[0]")[0] ?? 0),
    yes_chg_24h: typeof m.oneDayPriceChange === "number" ? Math.round(m.oneDayPriceChange * 1000) / 1000 : null,
    volume: Math.round(m.volumeNum ?? 0),
    url: `https://polymarket.com/market/${m.slug ?? ""}`,
  };
}

/**
 * "Who wins X" path: find Polymarket's grouped WINNER event (many "Will [entrant]
 * win the [contest]" markets) and rank entrants by probability — so the answer
 * leads with the actual favourite, not a high-volume longshot.
 */
async function winnerMarkets(searchPhrase: string, subjectTerms: string[]): Promise<PredictionVenue | null> {
  const events = await searchGamma(searchPhrase);
  if (!events) return null;
  // Pick the event that is most clearly a multi-entrant winner market and matches
  // the subject: count active "... win the ..." markets whose text hits a subject term.
  let best: { markets: NonNullable<GammaEvent["markets"]>; score: number } | null = null;
  for (const e of events) {
    const title = (e.title ?? "").toLowerCase();
    const winnerish = (e.markets ?? []).filter(
      (m) => m.active && !m.closed && /\bwin the\b/i.test(m.question ?? "") && (m.volumeNum ?? 0) >= VOLUME_FLOOR
    );
    if (winnerish.length < 4) continue;
    const matches = subjectTerms.length === 0 || subjectTerms.some((t) => title.includes(t) || winnerish.some((m) => (m.question ?? "").toLowerCase().includes(t)));
    if (!matches) continue;
    if (!best || winnerish.length > best.score) best = { markets: winnerish, score: winnerish.length };
  }
  if (!best) return null;
  const markets = best.markets
    .slice()
    .sort((a, b) => Number(JSON.parse(b.outcomePrices ?? "[0]")[0] ?? 0) - Number(JSON.parse(a.outcomePrices ?? "[0]")[0] ?? 0))
    .slice(0, 6)
    .map(toMarket);
  return markets.length > 0 ? { markets } : null;
}

// PREDICTION lens — how outcome markets price the related story (Polymarket
// public read API; free, no auth). Honest null when nothing relevant matches.
/** Search terms + named entities for a subject (shared by every prediction venue). */
export async function predictionTerms(subject: string, budget: BudgetGuard): Promise<{ keywords: string[]; entities: string[]; winner_query: boolean }> {
  return structuredCall<{ keywords: string[]; entities: string[]; winner_query: boolean }>({
    label: "prediction_keywords",
    system:
      "Extract prediction-market search terms for a subject. Keep the specific named entities (teams, people, places, tickers) — never generalise a specific matchup up to its umbrella event. Only propose terms for outcomes a real prediction market would plausibly list (elections, sports, macro, majors like BTC/ETH, big public figures). For a niche memecoin with no real-world event behind it, return empty arrays.",
    user: subject,
    schema: KEYWORDS_SCHEMA as unknown as Record<string, unknown>,
    budget,
    maxTokens: 200,
    effort: "low",
  });
}

export const predictionLens: Lens<PredictionVenue> = {
  name: "prediction",
  async read(resolved: Resolved, budget: BudgetGuard): Promise<PredictionVenue | null> {
    const subject = resolved.type === "token" ? `token ${resolved.name}` : resolved.name;
    const { keywords, entities, winner_query } = await predictionTerms(subject, budget);

    // Gamma search is literal: narrow phrases surface stale closed markets while
    // broad terms surface live ones. Search the joined phrase AND each keyword,
    // merge, dedupe — the open+volume filter below does the real selection.
    if (keywords.length === 0) return null;

    const subjectTerms = [...entities, ...keywords].map((t) => t.toLowerCase()).filter((t) => t.length > 2);

    // "Who wins X" → dedicated winner-event path (favourite-first). Fall through to
    // the general path if no clean winner event is found.
    if (winner_query) {
      const winner = await winnerMarkets(`${keywords.join(" ")} winner`, subjectTerms);
      if (winner) return winner;
    }

    // Search each entity/keyword individually AND the joined phrase — a per-entity
    // search ("spain", "portugal") surfaces the match event that a joined-only
    // search can miss.
    const queries = [...new Set([keywords.join(" "), ...entities, ...keywords].filter(Boolean))].slice(0, 5);
    const results = await Promise.all(queries.map(searchGamma));
    const seen = new Set<string>();
    const events = results
      .filter((r): r is GammaEvent[] => r !== null)
      .flat()
      .filter((e) => {
        const k = e.title ?? "";
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    if (events.length === 0) return null;

    // Ranking: RELEVANCE before volume. A market that prices the exact entities the
    // user named (e.g. both "spain" AND "portugal" in a match market) must beat a
    // giant but tangential market (e.g. "USA win the World Cup"). Volume-only sort
    // buries the specific fixture under tournament markets — the Spain/Portugal bug.
    const ents = entities.map((e) => e.toLowerCase()).filter(Boolean);
    const terms = keywords.flatMap((k) => k.toLowerCase().split(/\s+/)).filter((t) => t.length > 2);
    const matchTerms = ents.length > 0 ? ents : terms;

    // score = # of distinct named entities the market (its own question + parent
    // event title) references. Skew-related zero-volume novelty markets ("will the
    // announcer say X") are filtered by the volume floor.
    const scored = events
      .flatMap((e) => (e.markets ?? []).map((m) => ({ m, eventTitle: (e.title ?? "").toLowerCase() })))
      .filter(({ m }) => m.active && !m.closed && (m.volumeNum ?? 0) >= VOLUME_FLOOR)
      .map(({ m, eventTitle }) => {
        const hay = `${eventTitle} ${(m.question ?? "").toLowerCase()}`;
        const relevance = matchTerms.filter((t) => hay.includes(t)).length;
        const yesPrice = Number(JSON.parse(m.outcomePrices ?? "[0]")[0] ?? 0);
        return { m, relevance, yesPrice, volume: m.volumeNum ?? 0 };
      })
      .filter((s) => s.relevance > 0)
      // Rank: relevance → then the market's own PROBABILITY (favourites first) →
      // then volume. Probability-before-volume is what makes "who wins X" surface
      // the actual favourite instead of the biggest-volume longshot.
      .sort((a, b) => b.relevance - a.relevance || b.yesPrice - a.yesPrice || b.volume - a.volume);

    // If the top market prices a specific matchup (relevance ≥2 = both teams), keep
    // only that tier — don't dilute a clean head-to-head read with tournament odds.
    const topRelevance = scored[0]?.relevance ?? 0;
    const pool = topRelevance >= 2 ? scored.filter((s) => s.relevance >= 2) : scored;

    const markets = pool.slice(0, 5).map(({ m }) => ({
      question: m.question ?? "",
      venue: "polymarket",
      yes_price: Number(JSON.parse(m.outcomePrices ?? "[0]")[0] ?? 0),
      yes_chg_24h: typeof m.oneDayPriceChange === "number" ? Math.round(m.oneDayPriceChange * 1000) / 1000 : null,
      volume: Math.round(m.volumeNum ?? 0),
      url: `https://polymarket.com/market/${m.slug ?? ""}`,
    }));

    return markets.length > 0 ? { markets } : null;
  },
};

if (isCliEntry(import.meta.url)) {
  const budget = new BudgetGuard();
  const q = process.argv[2] ?? "fed rate";
  const out = await predictionLens.read({ type: "narrative", name: q }, budget);
  console.log(JSON.stringify(out, null, 2));
  console.log(`cost: $${budget.total().toFixed(5)}`);
}
