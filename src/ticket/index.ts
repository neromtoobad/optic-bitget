// TICKET DESK — venue: CEX Wallet prediction markets (USDT-settled).
//
// Optic turns a decision the CALLER has already made into a ready-to-place order
// on their OWN CEX Agentic Wallet. Optic never chooses the side, holds no
// session and signs nothing: it constructs the order, the caller's wallet places
// it behind its own confirmation gate. Every ticket is logged, like every pick.
import { db } from "../db.js";
import { isCliEntry } from "../fixtures.js";
import type { AgenticWalletRail } from "./cex.js";

export interface Ticket {
  venue: "cex-prediction";
  settlement: "USDT";
  economics: {
    outcome: string;
    inst_id: string; // the prediction market's token id
    limit_price: number; // price of the submitted order (Yes-book terms)
    contracts: number;
    usdt_at_risk: number;
  };
  draft: null; // reserved: a self-submitted order draft, unused on the wallet rail
  plugin_rail: AgenticWalletRail | null; // buyer-rails execution via the CEX Agentic Wallet
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
  book: null;
  ticket: Ticket | null;
  verdict_line: string;
  generated_at: string;
}

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

export async function planTicket(p: TicketParams): Promise<TicketVerdict> {
  return (await import("./cex.js")).planCEXTicket(p);
}

if (isCliEntry(import.meta.url)) {
  const [query, side, usdt] = [process.argv[2] ?? "", process.argv[3] ?? "yes", Number(process.argv[4] ?? 10)];
  console.log(JSON.stringify(await planTicket({ query, side: side as "yes" | "no", usdt }), null, 2));
}
