// TICKET DESK (Binance edition) — venue: Binance Wallet prediction markets
// (Predict.fun outcome tokens on BNB Chain, USDT collateral). Same rule as the
// OKX desk: THE CALLER BRINGS THE CONVICTION. The request names the event, the
// side and the size; Optic resolves the live market, reads the priced outcome,
// sizes the order and hands back the exact Agentic Wallet commands — the skill
// Binance ships for its own wallet (`baw prediction trade quote` → `place-order`).
// Optic never quotes, never signs, never submits, never holds a wallet session.
import { randomUUID } from "node:crypto";
import { db } from "../db.js";
import { pmSearch, pmUrl, type PmTopic, type PmMarket, type PmOutcome } from "../lib/binance/web3.js";
import type { TicketParams, TicketVerdict } from "./index.js";

export interface AgenticWalletRail {
  rail: "binance-agentic-wallet";
  skill: "binance-agentic-wallet"; // npx skills add https://github.com/binance/binance-skills-hub --skill binance-agentic-wallet
  chain_id: 56;
  market_topic_id: number;
  market_id: number;
  token_id: string; // ERC-1155 outcome token the order is for
  outcome: string;
  side: "BUY";
  amount_usdt: number;
  quote_command: string; // step 1 — returns quoteId + slippageBps
  place_command: string; // step 2 — the wallet's own confirmation gate applies
  market_url: string;
  note: string;
}

const now = () => new Date().toISOString();

// The 5m/15m windows resolve before a human can finish the two-step flow.
const TOO_SHORT = /updown-(5|15)m|\b(5|15)m\b/i;

/** Pick the market + outcome the caller means. Yes/No or Up/Down markets map the side directly;
 *  for a grouped topic (many entrants) the side applies to the entrant the query names. */
function pickOutcome(topics: PmTopic[], query: string, side: "yes" | "no"): { t: PmTopic; m: PmMarket; o: PmOutcome; score: number } | null {
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  let best: { t: PmTopic; m: PmMarket; o: PmOutcome; score: number } | null = null;
  for (const t of topics) {
    if (TOO_SHORT.test(`${t.slug} ${t.title}`)) continue;
    if ((t.status ?? "") === "RESOLVED" || (t.endDate && t.endDate < Date.now())) continue;
    for (const m of t.markets ?? []) {
      if ((m.tradingStatus ?? "OPEN") !== "OPEN" || !m.outcomes?.length) continue;
      const hay = `${t.title} ${t.question ?? ""} ${m.title} ${m.question ?? ""}`.toLowerCase();
      const score = words.filter((w) => hay.includes(w)).length + (m.tradeVolume ?? 0) / 1e6;
      const positive = m.outcomes.find((o) => /^(yes|up)$/i.test(o.name)) ?? m.outcomes[0];
      const negative = m.outcomes.find((o) => /^(no|down)$/i.test(o.name)) ?? m.outcomes[1] ?? positive;
      const o = side === "yes" ? positive : negative;
      if (!best || score > best.score) best = { t, m, o, score };
    }
  }
  return best && best.score >= 1 ? best : null;
}

export async function planBinanceTicket(p: TicketParams): Promise<TicketVerdict> {
  const fail = (line: string): TicketVerdict => ({ ticket_id: null, query: p.query, resolved: null, book: null, ticket: null, verdict_line: line, generated_at: now() });

  const topics = (await pmSearch(p.query, 20)) ?? [];
  const pick = pickOutcome(topics, p.query, p.side);
  if (!pick) return fail(`No live Binance Wallet prediction market matches "${p.query}" — try a named event ("Fed decision in September"), a price condition ("BTC hit 90000 first"), or a fixture ("Dodgers vs Cardinals").`);
  const { t, m, o } = pick;
  if (!o.tokenId) return fail(`"${m.title}" has no tradable outcome token published yet — try again shortly.`);

  const price = o.price;
  if (!(price > 0 && price < 1)) return fail(`"${m.title}" is priced at ${price} — nothing to construct on a settled outcome.`);
  if (p.limit !== undefined && !(p.limit > 0 && p.limit < 1)) return fail(`limit, when given, must be between 0 and 1 (got ${p.limit}).`);
  const limitPrice = p.limit ?? price;
  const contracts = Number((p.usdt / Math.max(limitPrice, 0.01)).toFixed(2));

  const quote = `baw prediction trade quote --binanceChainId 56 --tokenId ${o.tokenId} --marketTopicId ${t.marketTopicId} --side BUY --amount ${p.usdt} --orderType ${p.limit !== undefined ? "LIMIT" : "MARKET"}${p.limit !== undefined ? ` --priceLimit ${p.limit}` : ""} --json`;
  const place = `baw prediction trade place-order --quoteId <quoteId from step 1> --slippageBps <slippageBps from step 1>${p.limit !== undefined ? ` --orderType LIMIT --priceLimit ${p.limit}` : ""} --json`;
  const rail: AgenticWalletRail = {
    rail: "binance-agentic-wallet",
    skill: "binance-agentic-wallet",
    chain_id: 56,
    market_topic_id: t.marketTopicId,
    market_id: m.marketId,
    token_id: o.tokenId,
    outcome: o.name,
    side: "BUY",
    amount_usdt: p.usdt,
    quote_command: quote,
    place_command: place,
    market_url: pmUrl(t.slug, (t.topicType ?? "") === "GROUPED"),
    note: "Runs on the caller's own Binance Agentic Wallet (baw). Step 1 quotes, step 2 places; the wallet's confirm-before-place gate and daily prediction limit apply. Optic holds no session and signs nothing.",
  };

  const ticketId = randomUUID();
  db.prepare("INSERT INTO event_ticket (id, inst_id, question, outcome, limit_price, usdt, created_at) VALUES (?,?,?,?,?,?,?)").run(
    ticketId,
    `binance:${t.slug}#${m.marketId}`,
    m.question ?? m.title,
    o.name,
    limitPrice,
    p.usdt,
    now()
  );

  return {
    ticket_id: ticketId,
    query: p.query,
    resolved: {
      type: "event_contract",
      inst_id: `binance:${t.slug}#${m.marketId}`,
      series_id: t.eventSlug ?? t.slug,
      question: m.question ?? m.title,
      expiry_ms: t.endDate ?? null,
      state: (m.tradingStatus ?? "OPEN") === "OPEN" ? "live" : "closed",
      vol_24h: m.tradeVolume ?? 0,
    },
    book: null,
    ticket: {
      venue: "binance-prediction",
      settlement: "USDT",
      economics: { outcome: o.name, inst_id: o.tokenId, limit_price: limitPrice, contracts, usdt_at_risk: p.usdt },
      draft: null,
      plugin_rail: rail,
    },
    verdict_line:
      `Ticket constructed: ${o.name} on "${m.question ?? m.title}" — ${p.usdt} USDT at ${limitPrice} on Binance Wallet prediction markets (${t.title}). ` +
      `Run the two included baw commands with your own Agentic Wallet; the wallet's confirmation gate applies.`,
    generated_at: now(),
  };
}
