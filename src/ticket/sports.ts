// TICKET DESK · sports & general Polymarket lane (plugin rail).
//
// Same execution rail as the 5-min updown lane — OKX's own polymarket-plugin, run by
// the CALLER's agentic wallet — but pointed at Polymarket's full catalogue: sports
// (World Cup, NBA, …), elections, anything with a Yes/No book. Optic resolves the
// query to the single most relevant market and emits the one command; the plugin's
// own gates (paper-mode default, typed live-mode confirm, previews) do the rest.
//
// Resolution lessons carried over from the first build (see memory
// prediction-lens-relevance-ranking): rank by NAMED-ENTITY relevance before volume —
// a specific query must match its market's words, not just the biggest tournament
// market; keep "win" out of the stop list; volume only breaks ties.
const GAMMA = "https://gamma-api.polymarket.com";
const TIMEOUT_MS = 10_000;

export interface SportsMarket {
  condition_id: string;
  question: string;
  slug: string;
  yes_price: number | null;
  volume_24h: number;
  end_date: string | null;
  accepting_orders: boolean;
}

interface GammaMarket {
  question?: string;
  conditionId?: string;
  slug?: string;
  endDate?: string;
  volume24hr?: number | string;
  acceptingOrders?: boolean;
  active?: boolean;
  closed?: boolean;
  outcomes?: string;
  outcomePrices?: string;
}

const STOP = new Set(["will", "the", "a", "an", "to", "of", "in", "on", "for", "and", "or", "by", "is", "be", "at", "who"]);
const tokenize = (s: string): string[] =>
  s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((t) => t.length > 1 && !STOP.has(t));

function isBinary(m: GammaMarket): boolean {
  try {
    const o = JSON.parse(m.outcomes ?? "[]") as string[];
    return o.length === 2 && o[0].toLowerCase() === "yes" && o[1].toLowerCase() === "no";
  } catch {
    return false;
  }
}

function yesPrice(m: GammaMarket): number | null {
  try {
    const o = JSON.parse(m.outcomes ?? "[]") as string[];
    const p = JSON.parse(m.outcomePrices ?? "[]") as string[];
    const i = o.findIndex((x) => x.toLowerCase() === "yes");
    return i >= 0 ? Number(p[i]) : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a plain-words query ("spain to win the world cup") to the single most
 * relevant open Yes/No Polymarket market. Direct condition-id and slug inputs
 * short-circuit. Returns null honestly when nothing clears the relevance floor.
 */
export async function resolveSportsMarket(query: string): Promise<SportsMarket | null> {
  const q = query.trim();
  const fetchJson = async (url: string): Promise<GammaMarket[] | null> => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      return res.ok ? ((await res.json()) as GammaMarket[]) : null;
    } catch {
      return null;
    }
  };

  // direct handles first: condition id or slug
  let candidates: GammaMarket[] = [];
  if (/^0x[0-9a-fA-F]{64}$/.test(q)) {
    candidates = (await fetchJson(`${GAMMA}/markets?condition_ids=${q}`)) ?? [];
  } else if (/^[a-z0-9-]{8,}$/.test(q) && q.includes("-")) {
    candidates = (await fetchJson(`${GAMMA}/markets?slug=${q}`)) ?? [];
  }

  if (!candidates.length) {
    // text search via public-search (events carry their markets), merged with the
    // top-volume list so headline markets are always in the pool
    const want = tokenize(q);
    if (!want.length) return null;
    const [search, topVol] = await Promise.all([
      (async () => {
        try {
          const res = await fetch(`${GAMMA}/public-search?q=${encodeURIComponent(q)}&limit_per_type=25`, {
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });
          if (!res.ok) return [];
          const j = (await res.json()) as { events?: Array<{ markets?: GammaMarket[] }>; markets?: GammaMarket[] };
          return [...(j.markets ?? []), ...(j.events ?? []).flatMap((e) => e.markets ?? [])];
        } catch {
          return [];
        }
      })(),
      fetchJson(`${GAMMA}/markets?active=true&closed=false&order=volume24hr&ascending=false&limit=100`),
    ]);
    candidates = [...search, ...(topVol ?? [])];

    let best: { m: GammaMarket; score: number } | null = null;
    const seen = new Set<string>();
    for (const m of candidates) {
      if (!m.conditionId || seen.has(m.conditionId)) continue;
      seen.add(m.conditionId);
      if (m.closed || m.active === false || m.acceptingOrders === false || !isBinary(m)) continue;
      const hay = tokenize(m.question ?? "");
      const hits = want.filter((w) => hay.includes(w)).length;
      const score = hits / want.length + Math.min(0.1, Number(m.volume24hr ?? 0) / 1_000_000); // volume = tiebreak only
      if (!best || score > best.score) best = { m, score };
    }
    if (!best || best.score < 0.6) return null; // relevance floor — specific queries must actually match
    candidates = [best.m];
  }

  const m = candidates[0];
  if (!m?.conditionId || m.closed || m.acceptingOrders === false || !isBinary(m)) return null;
  return {
    condition_id: m.conditionId,
    question: m.question ?? q,
    slug: m.slug ?? "",
    yes_price: yesPrice(m),
    volume_24h: Number(m.volume24hr ?? 0),
    end_date: m.endDate ?? null,
    accepting_orders: m.acceptingOrders ?? true,
  };
}

export interface SportsRail {
  venue: "polymarket";
  executes_via: "okx polymarket-plugin (plugin-store) + the caller's own OKX agentic wallet";
  market: SportsMarket;
  outcome: "Yes" | "No";
  command: string;
  note: string;
}

/** Construct the plugin-rail instruction for a Yes/No market. */
export function buildSportsRail(market: SportsMarket, side: "yes" | "no", usd: number): SportsRail {
  const outcome = side === "yes" ? "Yes" : "No";
  return {
    venue: "polymarket",
    executes_via: "okx polymarket-plugin (plugin-store) + the caller's own OKX agentic wallet",
    market,
    outcome,
    command: `polymarket-plugin buy --market-id ${market.condition_id} --outcome ${side} --amount ${usd}`,
    note:
      "The plugin runs on YOUR wallet with its own confirmation gates (paper-mode default, typed live-mode switch, preview before every order).",
  };
}
