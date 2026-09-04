// TICKET DESK — the 8th service. Venue: OKX Event Contracts (v5 EVENTS, USDT-settled).
//
// "OKX AI has ASPs surfacing mispriced odds… What's missing is execution."
//
// The rule that keeps this inside Optic's spine: THE CALLER BRINGS THE CONVICTION.
// The request names the event, the side and the size; Optic resolves the live contract,
// reads the book, and drafts the exact order payload. It never chooses, never advises,
// never signs, never submits, never touches a trade key. The caller submits the draft
// with their OWN OKX API key. Every ticket is logged, like every pick.
import { randomUUID } from "node:crypto";
import { db } from "../db.js";
import { isCliEntry } from "../fixtures.js";
import {
  buildEventDraft,
  fetchEventBook,
  resolveEventContract,
  type EventOrderDraft,
  type EventsBook,
} from "./events.js";
import { buildPluginRail, isUpdownQuery, resolveUpdown, updownCoin, type PluginRail } from "./updown.js";
import { buildSportsRail, resolveSportsMarket, type SportsRail } from "./sports.js";
import { config } from "../config.js";
import type { AgenticWalletRail } from "./cex.js";

export interface Ticket {
  venue: "okx-events" | "polymarket-updown" | "polymarket" | "cex-prediction";
  settlement: "USDT" | "USDC";
  economics: {
    outcome: string;
    inst_id: string; // OKX instId, or the Polymarket condition id on the plugin rail
    limit_price: number; // price of the submitted order (YES/Up-book terms)
    contracts: number;
    usdt_at_risk: number;
  };
  draft: EventOrderDraft | null; // OKX rail: the caller submits with their own OKX API key
  plugin_rail: PluginRail | SportsRail | AgenticWalletRail | null; // buyer-rails execution: OKX polymarket-plugin, or CEX Agentic Wallet
}

export interface TicketVerdict {
  ticket_id: string | null;
  query: string;
  resolved: {
    type: "event_contract";
    inst_id: string;
    series_id: string;
    question: string;
    expiry_ms: number | null;
    state: string;
    vol_24h: number;
  } | null;
  book: EventsBook | null;
  ticket: Ticket | null;
  verdict_line: string;
  generated_at: string;
}

const now = () => new Date().toISOString();

db.exec(`CREATE TABLE IF NOT EXISTS event_ticket (
  id          TEXT PRIMARY KEY,
  inst_id     TEXT NOT NULL,
  question    TEXT NOT NULL,
  outcome     TEXT NOT NULL,
  limit_price REAL NOT NULL,
  usdt        REAL NOT NULL,
  paid_tx     TEXT,
  created_at  TEXT NOT NULL
)`);

/** Settlement middleware attaches the on-chain fee tx to the ticket record. */
export function attachTicketTx(id: string, tx: string): void {
  db.prepare("UPDATE event_ticket SET paid_tx = ? WHERE id = ?").run(tx, id);
}

export interface TicketParams {
  query: string;
  side: "yes" | "no";
  usdt: number; // capital to commit, in USDT
  limit?: number; // optional explicit YES-side limit price in (0,1)
}

/** Ticket on the buyer-rails plugin venue (Polymarket 5-min Up/Down via OKX's plugin). */
function updownTicket(p: TicketParams, market: import("./updown.js").UpdownMarket, ): TicketVerdict {
  const rail = buildPluginRail(market, p.side, p.usdt);
  const price = (p.side === "yes" ? market.up_price : market.down_price) ?? 0.5;
  const contracts = Number((p.usdt / Math.max(price, 0.01)).toFixed(2));
  const ticket: Ticket = {
    venue: "polymarket-updown",
    settlement: "USDC",
    economics: {
      outcome: rail.outcome,
      inst_id: market.condition_id,
      limit_price: price,
      contracts,
      usdt_at_risk: p.usdt,
    },
    draft: null,
    plugin_rail: rail,
  };
  const ticketId = randomUUID();
  db.prepare(
    "INSERT INTO event_ticket (id, inst_id, question, outcome, limit_price, usdt, created_at) VALUES (?,?,?,?,?,?,?)",
  ).run(ticketId, market.condition_id, market.question, rail.outcome, price, p.usdt, now());
  return {
    ticket_id: ticketId,
    query: p.query,
    resolved: {
      type: "event_contract",
      inst_id: market.condition_id,
      series_id: `${market.coin}-UPDOWN-5M`,
      question: market.question,
      expiry_ms: Date.parse(market.window_end_utc) || null,
      state: market.accepting_orders ? "live" : "closed",
      vol_24h: market.liquidity,
    },
    book: null,
    ticket,
    verdict_line:
      `Ticket constructed: ${rail.outcome} on "${market.question}" — ` +
      `${p.usdt} USDC via your own OKX polymarket-plugin (window closes ${market.window_end_utc}). ` +
      `Run the included command with your agentic wallet; the plugin's own confirmation gates apply.`,
    generated_at: now(),
  };
}

/** Ticket on the general Polymarket lane (sports/elections/any Yes-No market). */
function sportsTicket(p: TicketParams, market: import("./sports.js").SportsMarket): TicketVerdict {
  const rail = buildSportsRail(market, p.side, p.usdt);
  const yes = market.yes_price;
  const price = p.side === "yes" ? (yes ?? 0.5) : yes !== null ? Number((1 - yes).toFixed(3)) : 0.5;
  const contracts = Number((p.usdt / Math.max(price, 0.01)).toFixed(2));
  const ticket: Ticket = {
    venue: "polymarket",
    settlement: "USDC",
    economics: {
      outcome: rail.outcome,
      inst_id: market.condition_id,
      limit_price: price,
      contracts,
      usdt_at_risk: p.usdt,
    },
    draft: null,
    plugin_rail: rail,
  };
  const ticketId = randomUUID();
  db.prepare(
    "INSERT INTO event_ticket (id, inst_id, question, outcome, limit_price, usdt, created_at) VALUES (?,?,?,?,?,?,?)",
  ).run(ticketId, market.condition_id, market.question, rail.outcome, price, p.usdt, now());
  return {
    ticket_id: ticketId,
    query: p.query,
    resolved: {
      type: "event_contract",
      inst_id: market.condition_id,
      series_id: "POLYMARKET",
      question: market.question,
      expiry_ms: market.end_date ? Date.parse(market.end_date) || null : null,
      state: market.accepting_orders ? "live" : "closed",
      vol_24h: market.volume_24h,
    },
    book: null,
    ticket,
    verdict_line:
      `Ticket constructed: ${rail.outcome} on "${market.question}" — ` +
      `${p.usdt} USDC via your own OKX polymarket-plugin. ` +
      `Run the included command with your agentic wallet; the plugin's own confirmation gates apply.`,
    generated_at: now(),
  };
}

function fail(query: string, line: string): TicketVerdict {
  return {
    ticket_id: null,
    query,
    resolved: null,
    book: null,
    ticket: null,
    verdict_line: line,
    generated_at: now(),
  };
}

export async function planTicket(p: TicketParams): Promise<TicketVerdict> {
  // CEX edition: CEX Wallet prediction markets via the caller's Agentic Wallet.
  if (config.exchange === "cex") return (await import("./cex.js")).planCEXTicket(p);
  // Short-horizon up/down intent rides the buyer-rails plugin venue (verified live:
  // OKX's polymarket-plugin, running on the caller's own agentic wallet).
  if (isUpdownQuery(p.query)) {
    const coin = updownCoin(p.query);
    if (coin) {
      const market = await resolveUpdown(coin);
      if (market) return updownTicket(p, market);
    }
  }

  const contract = await resolveEventContract(p.query);
  if (!contract) {
    // Sports / elections / general markets: the plugin rail covers Polymarket's whole
    // Yes/No catalogue. Tried after the OKX venue so crypto/gold price queries keep
    // their USDT rail; queries with no tradable asset land here naturally.
    const sports = await resolveSportsMarket(p.query);
    if (sports) return sportsTicket(p, sports);
    return fail(
      p.query,
      `No live market matches "${p.query}" — try an asset condition ("BTC above 60000 today"), a short window ("BTC next 5 min"), or a named event ("spain to win the world cup").`,
    );
  }
  if (contract.state !== "live")
    return fail(p.query, `"${contract.question}" is not currently tradable (state: ${contract.state}).`);

  const book = await fetchEventBook(contract.inst_id);
  if (!book) return fail(p.query, `Book unavailable for "${contract.question}" — try again shortly.`);
  if (p.limit !== undefined && !(p.limit > 0 && p.limit < 1))
    return fail(p.query, `limit, when given, must be between 0 and 1 (got ${p.limit}).`);

  const draft = buildEventDraft({ contract, book, usdt: p.usdt, side: p.side, limit: p.limit });
  if (!draft)
    return fail(
      p.query,
      `Could not size an order for ${p.usdt} USDT on "${contract.question}" (min size ${contract.min_size}, book may be one-sided).`,
    );

  const price = Number(draft.payload.px);
  const contracts = Number(draft.payload.sz);
  const atRisk = Number((contracts * (p.side === "yes" ? price : 1 - price)).toFixed(2));
  const ticket: Ticket = {
    venue: "okx-events",
    settlement: "USDT",
    economics: {
      outcome: p.side === "yes" ? "Yes" : "No",
      inst_id: contract.inst_id,
      limit_price: price,
      contracts,
      usdt_at_risk: atRisk,
    },
    draft,
    plugin_rail: null,
  };

  const ticketId = randomUUID();
  db.prepare(
    "INSERT INTO event_ticket (id, inst_id, question, outcome, limit_price, usdt, created_at) VALUES (?,?,?,?,?,?,?)",
  ).run(ticketId, contract.inst_id, contract.question, ticket.economics.outcome, price, p.usdt, now());

  // Observational language only — the ticket reports what was CONSTRUCTED, never an
  // instruction (report-the-map rule; see src/lint.ts for the banned-word posture).
  return {
    ticket_id: ticketId,
    query: p.query,
    resolved: {
      type: "event_contract",
      inst_id: contract.inst_id,
      series_id: contract.series_id,
      question: contract.question,
      expiry_ms: contract.expiry_ms,
      state: contract.state,
      vol_24h: contract.vol_24h,
    },
    book,
    ticket,
    verdict_line:
      `Ticket constructed: ${ticket.economics.outcome} on "${contract.question}" — ` +
      `${contracts} contracts at ${price}, ${atRisk} USDT committed on OKX event contracts. ` +
      `Submit the draft with your own OKX API key to place.`,
    generated_at: now(),
  };
}

// CLI: npm run ticket -- "btc above 60000 today" yes 25 [limit]
if (isCliEntry(import.meta.url)) {
  const [q, side, usdt, limit] = process.argv.slice(2);
  planTicket({
    query: q || "btc above 60000 today",
    side: (side as "yes" | "no") || "yes",
    usdt: Number(usdt || 25),
    limit: limit ? Number(limit) : undefined,
  }).then((v) => console.log(JSON.stringify(v, null, 2)));
}
