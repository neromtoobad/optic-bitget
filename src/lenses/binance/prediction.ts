import type { PredictionMarket, PredictionVenue, Resolved } from "../../types.js";
import { pmSearch, pmUrl, pmYesOutcome, type PmTopic, type PmMarket } from "../../lib/binance/web3.js";
import { predictionTerms } from "../prediction.js";
import type { BudgetGuard } from "../../pipeline/budget.js";

// PREDICTION lens (Binance edition) — how Binance Wallet's prediction markets
// (Predict.fun-backed outcome tokens on BNB Chain, USDT collateral) price the
// related story. Same relevance-before-volume ranking as the Polymarket lens:
// a market that names the exact entities beats a bigger tangential one, and a
// wrong match is worse than null.

const VOLUME_FLOOR = 300; // USDT — Binance markets are younger/thinner than Polymarket
const SHORT_UPDOWN = /updown-(5|15)m|\b(5|15)m\b|up or down - .*\b\d{1,2}(:\d{2})?\s?(am|pm)\b/i; // intraday coin-flips (5m/15m/hourly ET windows) are noise for a read

function isOpen(t: PmTopic, m: PmMarket): boolean {
  return (m.tradingStatus ?? "OPEN") === "OPEN" && (t.status ?? "REGISTERED") !== "RESOLVED" && (!t.endDate || t.endDate > Date.now());
}

function toMarket(t: PmTopic, m: PmMarket): PredictionMarket | null {
  const yes = pmYesOutcome(m);
  if (!yes) return null;
  const grouped = (t.topicType ?? "") === "GROUPED" || t.markets.length > 1;
  return {
    question: grouped && !/\?$/.test(m.title) ? `${t.title} — ${m.title}` : m.question ?? m.title,
    venue: "binance-prediction",
    yes_price: Math.round(yes.price * 1000) / 1000,
    yes_chg_24h: null, // the public web API carries no 24h odds delta
    volume: Math.round(m.tradeVolume ?? 0),
    url: pmUrl(t.slug, grouped),
    outcome: yes.name,
    liquidity: m.liquidity ?? null,
    ends_at: t.endDate ? new Date(t.endDate).toISOString() : null,
    slug: t.slug,
    market_id: m.marketId,
    variant: t.marketVariant ?? "DEFAULT",
    participants: t.participantCount ?? null,
  };
}

/** Merge several searches, dedupe by topic slug. */
async function searchAll(queries: string[], budget: BudgetGuard): Promise<PmTopic[]> {
  const results = await Promise.all(queries.map((q) => pmSearch(q, 10, budget)));
  const seen = new Set<string>();
  const out: PmTopic[] = [];
  for (const list of results) {
    for (const t of list ?? []) {
      if (seen.has(t.slug)) continue;
      seen.add(t.slug);
      out.push(t);
    }
  }
  return out;
}

/** "Who wins X" → a GROUPED topic with many entrant markets, ranked by chance. */
function winnerMarkets(topics: PmTopic[], subjectTerms: string[]): PredictionVenue | null {
  let best: { t: PmTopic; open: PmMarket[] } | null = null;
  for (const t of topics) {
    if ((t.topicType ?? "") !== "GROUPED" && t.markets.length < 4) continue;
    const open = t.markets.filter((m) => isOpen(t, m));
    if (open.length < 4) continue;
    const hay = `${t.title} ${t.question ?? ""}`.toLowerCase();
    const matches = subjectTerms.length === 0 || subjectTerms.some((s) => hay.includes(s));
    if (!matches) continue;
    if (!best || open.length > best.open.length) best = { t, open };
  }
  if (!best) return null;
  const markets = best.open
    .map((m) => toMarket(best!.t, m))
    .filter((m): m is PredictionMarket => m !== null)
    .sort((a, b) => b.yes_price - a.yes_price)
    .slice(0, 6);
  return markets.length ? { markets } : null;
}

export async function predictionBinance(resolved: Resolved, budget: BudgetGuard): Promise<PredictionVenue | null> {
  const subject = resolved.type === "token" ? `token ${resolved.name}` : resolved.name;
  // A brain outage must degrade the read, not fail it: fall back to plain-word terms.
  const { keywords, entities, winner_query } = await predictionTerms(subject, budget).catch((err) => {
    console.error(`prediction terms failed, using heuristic: ${(err as Error).message}`);
    const words = resolved.name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
    return resolved.type === "token"
      ? { keywords: [resolved.name], entities: [resolved.name.toLowerCase()], winner_query: false }
      : { keywords: [words.join(" ")], entities: words.slice(0, 3), winner_query: /\b(who|which)\b.*\bwin/i.test(resolved.name) };
  });
  // A listed major always has Binance's own up/down + hit-price markets — search
  // the symbol too, even when the term extractor found no "real-world" event.
  const symbolTerms = resolved.type === "token" && resolved.cex_symbol ? [resolved.cex_symbol.replace(/USDT$/, "")] : [];
  const queries = [...new Set([keywords.join(" "), ...entities, ...keywords, ...symbolTerms].map((s) => s.trim()).filter(Boolean))].slice(0, 5);
  if (queries.length === 0) return null;

  const subjectTerms = [...entities, ...keywords, ...symbolTerms].map((t) => t.toLowerCase()).filter((t) => t.length > 1);
  const topics = await searchAll(queries, budget);
  if (topics.length === 0) return null;

  if (winner_query) {
    const winner = winnerMarkets(topics, subjectTerms);
    if (winner) return winner;
  }

  const ents = entities.map((e) => e.toLowerCase()).filter(Boolean);
  const terms = [...keywords.flatMap((k) => k.toLowerCase().split(/\s+/)), ...symbolTerms.map((s) => s.toLowerCase())].filter((t) => t.length > 1);
  const matchTerms = ents.length > 0 ? [...ents, ...symbolTerms.map((s) => s.toLowerCase())] : terms;

  const scored = topics
    .flatMap((t) => t.markets.map((m) => ({ t, m })))
    .filter(({ t, m }) => isOpen(t, m) && (m.tradeVolume ?? 0) >= VOLUME_FLOOR && !SHORT_UPDOWN.test(`${t.slug} ${t.title} ${m.title} ${m.question ?? ""}`))
    .map(({ t, m }) => {
      const hay = `${t.title} ${t.question ?? ""} ${m.title} ${m.question ?? ""} ${t.symbol ?? ""}`.toLowerCase();
      const relevance = matchTerms.filter((x) => hay.includes(x)).length;
      const yes = pmYesOutcome(m);
      return { t, m, relevance, yesPrice: yes?.price ?? 0, volume: m.tradeVolume ?? 0 };
    })
    .filter((s) => s.relevance > 0)
    .sort((a, b) => b.relevance - a.relevance || b.yesPrice - a.yesPrice || b.volume - a.volume);

  const topRelevance = scored[0]?.relevance ?? 0;
  const pool = topRelevance >= 2 ? scored.filter((s) => s.relevance >= 2) : scored;
  const markets = pool
    .slice(0, 5)
    .map(({ t, m }) => toMarket(t, m))
    .filter((m): m is PredictionMarket => m !== null);
  return markets.length > 0 ? { markets } : null;
}
