// The verdict schema is the product's spine (CLAUDE.md) — keep stable.

export interface Resolved {
  type: "token" | "narrative";
  name: string;
  chain?: string;
  address?: string;
  // CEX edition: the CEX trading pair this subject maps to (e.g. BTCUSDT),
  // when CEX lists it. Absent = not listed on the exchange.
  cex_symbol?: string;
}

export interface Attention {
  hotness: number | null;
  trend: string;
  mentions_24h: number | null;
  sentiment: { bull: number; bear: number; neutral: number } | null;
  top_kols: Array<{ handle: string; impressions: number | null; followers?: number | null }>;
  // CEX edition extras (CEX Web3 social hype board / topic radar). All
  // reported as-is.
  sentiment_label?: string | null; // Positive | Negative | Neutral
  summary?: string | null; // the board's AI social summary for the token / topic
  kol_count?: number | null;
  topic?: string | null; // matched hot narrative (narrative queries)
  source?: string; // e.g. "cex-web3:social-hype"
}

export interface MemeVenue {
  price: number | null;
  chg_24h: number | null;
  liquidity: number | null;
  holders: number | null;
  dev_flags: Record<string, unknown> | null;
  similar_tokens: Array<{ name: string; chain: string; market_cap_usd: number | null }>;
}

export interface PredictionMarket {
  question: string;
  venue: string;
  yes_price: number;
  yes_chg_24h: number | null; // 24h move in the yes-price — odds momentum
  volume: number;
  url: string;
  // CEX edition extras (CEX Wallet prediction markets on BNB Chain).
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

// CEX venue (CEX edition) — the centralised market read from the CEX
// MCP Server / CEX API: spot price + 24h, and the perps positioning that
// prices the SAME story on the exchange (funding, open interest, long/short).
export interface CEXVenue {
  symbol: string; // e.g. BTCUSDT
  // How this leg was obtained, stated only as far as Optic can verify it:
  //   "cex-api"      Optic fetched it from CEX's public data API itself.
  //   "cex-mcp"      Optic fetched it through an MCP session it holds the token
  //                      for, so the provenance is its own to vouch for.
  //   "caller-supplied"  the calling agent passed it in — typically from that agent's
  //                      own authorised CEX MCP session, but Optic cannot see
  //                      that, so it reports only the handover it witnessed.
  source: "cex-api" | "cex-mcp" | "caller-supplied";
  spot: {
    price: number | null;
    chg_24h: number | null; // percent
    volume_24h_usd: number | null;
    high_24h: number | null;
    low_24h: number | null;
  } | null;
  perps: {
    mark_price: number | null;
    funding_rate: number | null; // last funding rate as a fraction (0.0001 = 0.01%)
    funding_annualized_pct: number | null; // funding_rate * 3 * 365 * 100
    next_funding_at: string | null;
    open_interest: number | null; // contracts (base units)
    open_interest_usd: number | null;
    open_interest_chg_24h: number | null; // percent change in OI value over ~24h
    // Positioning, phrased so the language lint never trips on it downstream:
    accounts_up_pct: number | null; // share of futures accounts positioned for a rise (global account ratio)
    accounts_up_down_ratio: number | null; // up-positioned / down-positioned accounts
    taker_flow_ratio: number | null; // aggressive bid volume / aggressive ask volume (1h)
  } | null;
  basis_pct: number | null; // (mark - spot) / spot * 100
  read: string; // one-line factual summary of the exchange positioning
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

export interface Verdict {
  query: string;
  resolved: Resolved;
  attention: Attention | null;
  venues: {
    meme: MemeVenue | null;
    prediction: PredictionVenue | null;
    unlock_news: UnlockNews[] | null; // supply-event intelligence from news — factual, never advice
    news: UnlockNews[] | null; // research headlines for narrative subjects (sports, macro, events)
    cex?: CEXVenue | null; // CEX edition: the exchange (spot + perps) read
  };
  research: Research | null; // the value-add: web research behind the market read
  // Token-only alpha lenses (null for narratives):
  risk: import("./lenses/risk.js").RiskRadar | null; // Rug Radar safety score
  timing: import("./lenses/timing.js").Timing | null; // narrative lifecycle stage
  smart_money: import("./lenses/smartmoney.js").SmartMoneyToken | null; // smart-money activity on this token
  divergence: Divergence;
  verdict_line: string;
  generated_at: string;
  card_url: string | null;
  card_pending?: boolean;
}

// SCAN mode — discovery instead of a query-scoped read: where is attention
// accelerating before it's crowded, what's fresh in the trenches, what supply
// events are coming. Same engine, pointed at the whole market.
export interface ScanVerdict {
  query: string;
  resolved: { type: "scan"; name: string };
  scan: {
    rising: Array<{
      symbol: string;
      mentions_1h: number | null;
      mentions_24h: number | null;
      accel_x: number | null; // 1h mention rate vs 24h baseline
      sentiment_label: string | null;
      bullish_ratio: number | null;
    }>;
    fresh_trenches: Array<{
      symbol: string;
      address: string | null;
      market_cap_usd: number | null;
      volume_1h_usd: number | null;
    }>;
    unlock_calendar: UnlockNews[];
  };
  highlights: string[];
  verdict_line: string;
  generated_at: string;
  card_url: string | null;
  card_pending?: boolean;
}

// DAILY ALPHA mode — "what's today's prediction tip". Researches the strongest
// signals across prediction markets + meme momentum + supply events, and returns
// ranked, research-backed picks. Confidence is qualitative (signal strength), never
// a claimed win rate. Every pick cites the numbers behind it.
export interface DailyTip {
  category: "prediction" | "meme_momentum" | "supply_risk";
  headline: string; // the pick, in plain words
  research: string; // the evidence: the concrete numbers behind it
  confidence: "high" | "medium" | "watch"; // strength of the signal, NOT a win-rate
  url?: string;
}

export interface DailyVerdict {
  query: string;
  resolved: { type: "daily"; name: string };
  top_call: { headline: string; reason: string; category: DailyTip["category"] }; // OPTIC's single most decisive call of the day
  tips: DailyTip[];
  research: { brief: string; sources: string[] } | null; // web research behind the top call
  research_note: string; // what was scanned to produce these
  verdict_line: string;
  generated_at: string;
  card_url: string | null;
  card_pending?: boolean;
}

// EDGE mode — the mispricing radar (where research diverges from price).
export interface EdgeVerdict {
  query: string;
  resolved: { type: "edge"; name: string };
  edges: Array<{ market: string; market_price: string; read: string; why: string; edge_score: number; url: string }>;
  verdict_line: string;
  research_note: string;
  generated_at: string;
  card_url: string | null;
  card_pending?: boolean;
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

// RUG RADAR service — standalone token safety score.
export interface RugVerdict {
  query: string;
  resolved: Resolved;
  risk: import("./lenses/risk.js").RiskRadar | null;
  verdict_line: string;
  generated_at: string;
  card_url: string | null;
  card_pending?: boolean;
}

// TIMING service — standalone narrative lifecycle stage.
export interface TimingVerdict {
  query: string;
  resolved: Resolved;
  timing: import("./lenses/timing.js").Timing | null;
  verdict_line: string;
  generated_at: string;
  card_url: string | null;
  card_pending?: boolean;
}

// SMART MONEY mode — what sharp wallets are accumulating (discovery).
export interface SmartMoneyVerdict {
  query: string;
  resolved: { type: "smartmoney"; name: string };
  flow: Array<{ symbol: string; address: string; buy_usd: number; signals: number; wallets: number; market_cap_usd: number | null; top10_holder_pct: number | null }>;
  verdict_line: string;
  generated_at: string;
  card_url: string | null;
  card_pending?: boolean;
}

// STOCKS lens — exchange-listed tokenized equities read as one market in a
// cross-venue picture: on-chain xStock price vs real-world equity research vs any
// prediction market on the company. Data and analysis only, never advice — a
// stock is a security, so language stays observational (priced-in, lagging,
// diverging), never buy/sell/hold or a price target framed as a recommendation.
export interface StockTokenized {
  symbol: string; // e.g. TSLAon
  chain: string; // chainIndex (501 solana, 1 eth)
  address: string;
  price: number | null;
  chg_24h: number | null;
  liquidity: number | null;
  holders: number | null;
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
