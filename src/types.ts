// The verdict schema is the product's spine (CLAUDE.md) — keep stable.

export interface Resolved {
  type: "token" | "narrative";
  name: string;
  chain?: string;
  address?: string;
}

export interface PredictionMarket {
  question: string;
  venue: string;
  yes_price: number;
  yes_chg_24h: number | null; // 24h move in the yes-price — odds momentum
  volume: number;
  url: string;
  // Optional detail some prediction-market sources report.
  outcome?: string; // which outcome yes_price refers to (Yes / Up / entrant name)
  liquidity?: number | null;
  ends_at?: string | null;
  slug?: string; // topic slug
  market_id?: number;
  variant?: string; // DEFAULT | CRYPTO_UP_DOWN | SPORTS_MATCH …
  participants?: number | null;
}

export interface UnlockNews {
  title: string;
  summary: string | null;
  importance: string | null;
  source: string | null;
  published_at: string | null;
}

export interface PredictionVenue {
  markets: PredictionMarket[];
}

export interface Divergence {
  score: number; // 0-100
  direction: string;
  one_liner: string;
  reasoning: string[];
}

export interface Research {
  brief: string; // web-researched real-world context (form, injuries, catalysts)
  sources: string[];
}

// TOUCHGRASS service — onchain wellness read for a wallet (Lifestyle listing).
// Diagnosis (deterministic patterns from tx timestamps) → prescription (protocol
// items each traceable to a pattern). Entertainment + self-reflection framing;
// observational wellness language only — never medical, never financial.
export interface TouchGrassVerdict {
  query: string;
  resolved: { type: "touchgrass"; name: string; address: string; chains: string[] };
  wellness: import("./engine/wellness.js").Wellness | null;
  protocol: import("./engine/protocol.js").Protocol | null;
  verdict_line: string;
  generated_at: string;
  card_url: string | null;
  card_pending?: boolean;
}

// STOCKS lens — exchange-listed tokenized equities read as one market in a
// cross-market picture: the rToken perpetual vs real-world equity research vs any
// prediction market on the company. Data and analysis only, never advice — a
// stock is a security, so language stays observational (priced-in, lagging,
// diverging), never buy/sell/hold or a price target framed as a recommendation.
export interface StockTokenized {
  symbol: string; // e.g. TSLAon (on-chain) or TSLAUSDT (Bitget rToken perpetual)
  venue: "onchain" | "perpetual"; // how the exchange lists the tokenized share
  chain: string; // chainIndex (501 solana, 1 eth) — or "bitget-futures" for the perpetual
  address: string; // token contract on-chain; empty for the perpetual
  price: number | null; // per-share reference price (last trade for the perpetual)
  chg_24h: number | null; // percent
  liquidity: number | null; // on-chain pool liquidity; null for the perpetual (see volume_24h_usdt)
  holders: number | null; // on-chain holders; null for the perpetual
  // Perpetual-only — every field below is COMPUTED from exchange data, never argued.
  mark_price?: number | null;
  index_price?: number | null; // the underlying's reference price the perp is marked against
  basis_pct?: number | null; // (mark − index) / index × 100 — where the perp disagrees with its underlying
  funding_rate?: number | null; // current rate, fraction per interval
  funding_interval_h?: number | null;
  funding_annualized_pct?: number | null;
  open_interest?: number | null; // contracts
  open_interest_usdt?: number | null;
  volume_24h_usdt?: number | null;
  spread_bps?: number | null;
  us_session_open?: boolean | null; // is the underlying's cash market open right now
}

export interface StockRead {
  ticker: string;
  company: string;
  tokenized: StockTokenized | null; // the exchange-listed tokenized share, if any
  market_snapshot: string | null; // reported real-world price/level + recent move (from research)
  analyst_consensus: string | null; // reported sell-side consensus rating/target — data, attributed, not our call
  consensus_tag: string | null; // short reported rating for the card (e.g. "Strong Buy") — attributed data, not our call
  catalysts: string[]; // upcoming/recent catalysts (earnings, guidance, macro)
  divergence: Divergence; // where the venues diverge on the same company
}

export interface StockVerdict {
  query: string;
  resolved: { type: "stock"; name: string };
  stock: StockRead | null;
  prediction: PredictionVenue | null; // Polymarket markets on the company, if any
  research: Research | null; // the equity research brief + sources
  verdict_line: string;
  generated_at: string;
  card_url: string | null;
  card_pending?: boolean;
}

import type { BudgetGuard } from "./pipeline/budget.js";

// Lenses are adapters behind one interface. Any lens may return null —
// absence is signal, never invented data.
export interface Lens<T> {
  name: string;
  read(resolved: Resolved, budget: BudgetGuard): Promise<T | null>;
}
