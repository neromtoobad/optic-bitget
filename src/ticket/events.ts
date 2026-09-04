// TICKET DESK · OKX EVENT CONTRACTS adapter (v5 EVENTS, USDT-settled).
//
// Surface A of OKX's two prediction venues, probed live Jul 19:
//   GET /api/v5/market/tickers?instType=EVENTS            → 649 live contracts
//   GET /api/v5/public/instruments?instType=EVENTS&seriesId= → tickSz/lotSz/minSz/state
//   GET /api/v5/market/books?instId=                      → real YES-side depth
//   settleCcy=USDT — real-money settlement on OKX's main exchange.
//
// Each instrument IS the YES side of one question, and the instId encodes it:
//   ASSET-METHOD-FREQ-YYMMDD-HHMM-STRIKE[-STRIKE2]
//   BTC-ABOVE-DAILY-260720-1600-54000   "BTC above $54,000 at 16:00 UTC Jul 20?"
//   ETH-BETWEEN-DAILY-260724-1600-2100-2200, XAU-HIT-MONTHLY-260801-0500-3400,
//   SOL-UPDOWN-5MIN-260719-2015-2020 (up/down over a window; no strike).
// Price ∈ (0,1) ≈ implied probability. NO is the mirror: p(no) = 1 − p(yes).
//
// The custody rule is UNCHANGED: Optic resolves the contract, reads the live book,
// and drafts the exact order payload. The caller submits it with THEIR OWN OKX API
// key (POST /api/v5/trade/order). Optic never holds trade keys, never submits.
import { cacheKey, cacheGet, cacheSet } from "../db.js";

const BASE = "https://www.okx.com";
const TIMEOUT_MS = 10_000;

export class EventsError extends Error {
  constructor(public readonly path: string, public readonly code: string, msg: string) {
    super(`events ${path}: code=${code} ${msg}`);
    this.name = "EventsError";
  }
}

/** Market-data GETs on the EVENTS surface are public — no signing needed (probed live). */
async function get<T>(requestPath: string, opts: { cache?: boolean } = {}): Promise<T | null> {
  const key = cacheKey("events", { requestPath });
  if (opts.cache !== false) {
    const hit = cacheGet<T | null>(key);
    if (hit !== undefined) return hit;
  }
  try {
    const res = await fetch(BASE + requestPath, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const json = (await res.json()) as { code?: string; msg?: string; data?: T };
    if (res.status !== 200 || json.code !== "0") {
      console.error(new EventsError(requestPath, json.code ?? String(res.status), json.msg ?? "").message);
      return null;
    }
    const data = json.data ?? null;
    if (opts.cache !== false) cacheSet(key, data);
    return data;
  } catch (err) {
    console.error(new EventsError(requestPath, "network", (err as Error).message).message);
    return null;
  }
}

// ── types ────────────────────────────────────────────────────────────────────
export interface EventContract {
  inst_id: string;
  series_id: string; // e.g. BTC-ABOVE-DAILY
  asset: string; // BTC | ETH | SOL | XAU
  method: string; // ABOVE | BETWEEN | HIT | UPDOWN
  freq: string; // 5MIN | 15MIN | DAILY | MONTHLY
  question: string; // human rendering of the instId
  strikes: number[]; // [] for UPDOWN
  expiry_ms: number | null;
  yes_bid: number | null; // live ticker prices for the YES side
  yes_ask: number | null;
  vol_24h: number;
  // instrument metadata (from the instruments endpoint, fetched for the chosen series)
  tick_size: number;
  lot_size: number;
  min_size: number;
  state: string; // live | suspend | expired
}
export interface EventsBook {
  inst_id: string;
  best_bid: number | null;
  best_ask: number | null;
  asks: Array<[number, number]>; // [price, size] ascending — YES side
  bids: Array<[number, number]>; // [price, size] descending
}

// ── instId parsing ───────────────────────────────────────────────────────────
const ASSET_NAMES: Record<string, string> = { BTC: "Bitcoin", ETH: "Ether", SOL: "Solana", XAU: "gold" };

function parseExpiry(date6: string, time4: string): number | null {
  if (!/^\d{6}$/.test(date6) || !/^\d{4}$/.test(time4)) return null;
  const iso = `20${date6.slice(0, 2)}-${date6.slice(2, 4)}-${date6.slice(4, 6)}T${time4.slice(0, 2)}:${time4.slice(2, 4)}:00Z`;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "260720","1600" → "Jul 20, 16:00 UTC" (question text ends up on cards). */
function fmtWhen(date6: string, time4: string): string {
  const ms = parseExpiry(date6, time4);
  if (ms === null) return `${date6} ${time4} UTC`;
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${time4.slice(0, 2)}:${time4.slice(2, 4)} UTC`;
}

/** Decode an EVENTS instId into its question. Returns null on unrecognized shapes. */
export function parseInstId(instId: string): Omit<EventContract, "yes_bid" | "yes_ask" | "vol_24h" | "tick_size" | "lot_size" | "min_size" | "state"> | null {
  const p = instId.split("-");
  if (p.length < 5) return null;
  const [asset, method, freq] = p;
  const name = ASSET_NAMES[asset] ?? asset;
  const base = { inst_id: instId, series_id: `${asset}-${method}-${freq}`, asset, method, freq };

  if (method === "UPDOWN") {
    // two shapes: ASSET-UPDOWN-5MIN-YYMMDD-HHMM-HHMM  ·  ASSET-UPDOWN-DAILY-YYMMDDHHMM-YYMMDDHHMM
    if (p.length === 6 && /^\d{10}$/.test(p[4])) {
      const exp = parseExpiry(p[5].slice(0, 6), p[5].slice(6, 10));
      return { ...base, question: `${name} higher at window close (${p[4]} → ${p[5]} UTC)?`, strikes: [], expiry_ms: exp };
    }
    if (p.length === 6) {
      const exp = parseExpiry(p[3], p[5]);
      return { ...base, question: `${name} higher at ${p[5]} UTC than at ${p[4]} (${p[3]})?`, strikes: [], expiry_ms: exp };
    }
    return null;
  }

  const exp = parseExpiry(p[3], p[4]);
  const when = fmtWhen(p[3], p[4]);
  if (method === "ABOVE" && p.length === 6)
    return { ...base, question: `${name} above ${Number(p[5]).toLocaleString("en-US")} at ${when}?`, strikes: [Number(p[5])], expiry_ms: exp };
  if (method === "HIT" && p.length === 6)
    return { ...base, question: `${name} touches ${Number(p[5]).toLocaleString("en-US")} by ${when}?`, strikes: [Number(p[5])], expiry_ms: exp };
  if (method === "BETWEEN" && p.length === 7) {
    const lo = p[5] === "0" ? 0 : Number(p[5]);
    const hi = p[6] === "INF" ? Infinity : Number(p[6]);
    const range =
      hi === Infinity
        ? `above ${lo.toLocaleString("en-US")}`
        : lo === 0
          ? `below ${hi.toLocaleString("en-US")}`
          : `between ${lo.toLocaleString("en-US")} and ${hi.toLocaleString("en-US")}`;
    return { ...base, question: `${name} ${range} at ${when}?`, strikes: [lo, hi], expiry_ms: exp };
  }
  return null;
}

// ── resolve: plain words → the single best live contract ────────────────────
const ASSET_ALIASES: Record<string, string> = {
  btc: "BTC", bitcoin: "BTC",
  eth: "ETH", ether: "ETH", ethereum: "ETH",
  sol: "SOL", solana: "SOL",
  xau: "XAU", gold: "XAU",
};
const METHOD_HINTS: Array<[RegExp, string]> = [
  [/\babove\b|\bover\b|\bexceed/, "ABOVE"],
  [/\bbetween\b|\brange\b|\bbelow\b|\bunder\b/, "BETWEEN"],
  [/\bhit\b|\btouch\b|\breach\b/, "HIT"],
  [/\bup\b|\bdown\b|\bhigher\b|\blower\b|\bnext \d+ ?min/, "UPDOWN"],
];
const FREQ_HINTS: Array<[RegExp, string]> = [
  [/\b5 ?min/, "5MIN"],
  [/\b15 ?min/, "15MIN"],
  [/\bmonth/, "MONTHLY"],
  [/\btoday\b|\btomorrow\b|\bdaily\b|\bweek\b/, "DAILY"],
];

/** "60k" → 60000, plain numbers pass through. */
function parseNumbers(q: string): number[] {
  const out: number[] = [];
  for (const m of q.matchAll(/(\d+(?:\.\d+)?)\s*(k)?/gi)) {
    const n = Number(m[1]) * (m[2] ? 1000 : 1);
    if (Number.isFinite(n) && n >= 1) out.push(n);
  }
  return out;
}

export interface RawTicker { instId: string; bidPx: string; askPx: string; vol24h: string }

/** All live EVENTS tickers (fresh — no cache; pulse needs current prices). */
export async function listEventTickers(): Promise<RawTicker[] | null> {
  return get<RawTicker[]>("/api/v5/market/tickers?instType=EVENTS", { cache: false });
}

export interface SeriesInstrument { instId: string; expTime: string; state: string }
/**
 * Instruments of one series with AUTHORITATIVE expiry (`expTime`, ms). The instId's
 * embedded times are NOT reliably UTC (5MIN series encode UTC+8) — verified live:
 * BTC-UPDOWN-5MIN-…-2350-2355 carries expTime 15:55:00Z. Always expire off expTime.
 */
export async function listSeriesInstruments(seriesId: string): Promise<SeriesInstrument[] | null> {
  return get<SeriesInstrument[]>(`/api/v5/public/instruments?instType=EVENTS&seriesId=${encodeURIComponent(seriesId)}`, {
    cache: false,
  });
}

/**
 * Find the most relevant live contract for a plain-language query.
 * Asset is REQUIRED (a query that names no tradable asset resolves to null — honest).
 * Among asset matches: method hint, strike proximity, then nearest expiry, then volume.
 */
export async function resolveEventContract(query: string): Promise<EventContract | null> {
  const q = query.toLowerCase();
  const asset = Object.entries(ASSET_ALIASES).find(([alias]) => new RegExp(`\\b${alias}\\b`).test(q))?.[1];
  if (!asset) return null;
  const method = METHOD_HINTS.find(([re]) => re.test(q))?.[1];
  const freq = FREQ_HINTS.find(([re]) => re.test(q))?.[1];
  const wantStrikes = parseNumbers(q.replace(/\b\d+ ?min\b/g, "")); // don't read "5min" as a strike

  const tickers = await get<RawTicker[]>("/api/v5/market/tickers?instType=EVENTS");
  if (!tickers?.length) return null;

  const now = Date.now();
  let best: { c: ReturnType<typeof parseInstId> & object; t: RawTicker; score: number } | null = null;
  for (const t of tickers) {
    const c = parseInstId(t.instId);
    if (!c || c.asset !== asset) continue;
    if (c.expiry_ms !== null && c.expiry_ms < now) continue; // already expired
    let score = 1; // asset matched
    if (method) score += c.method === method ? 2 : -1;
    if (freq) score += c.freq === freq ? 1.5 : -0.5;
    if (wantStrikes.length && c.strikes.length) {
      // score EVERY wanted number against its nearest finite strike ("between 2100
      // and 2200" must beat the 2100-INF band), and prefer a matching strike count
      const finite = c.strikes.filter((s) => Number.isFinite(s) && s > 0);
      if (finite.length) {
        for (const w of wantStrikes.slice(0, 2)) {
          const d = Math.min(...finite.map((s) => Math.abs(s - w) / w));
          score += Math.max(0, 1.5 - d * 5) / wantStrikes.length; // full credit ≤ ~0%, fades by 30% away
        }
        if (finite.length === wantStrikes.length) score += 0.5;
      }
    }
    if (c.expiry_ms !== null) {
      const hours = (c.expiry_ms - now) / 3_600_000;
      score += Math.max(0, 0.5 - hours / 720); // mild preference for nearer expiry
    }
    score += Math.min(0.5, Number(t.vol24h || "0") / 1000); // liquidity tiebreak
    if (!best || score > best.score) best = { c, t, score };
  }
  if (!best || best.score < 2) return null; // must beat bare-asset match

  // instrument metadata for the chosen series (tick/lot/min/state)
  const instruments = await get<Array<Record<string, string>>>(
    `/api/v5/public/instruments?instType=EVENTS&seriesId=${best.c.series_id}`,
  );
  const meta = instruments?.find((i) => i.instId === best!.c.inst_id);
  return {
    ...best.c,
    yes_bid: best.t.bidPx ? Number(best.t.bidPx) : null,
    yes_ask: best.t.askPx ? Number(best.t.askPx) : null,
    vol_24h: Number(best.t.vol24h || "0"),
    tick_size: Number(meta?.tickSz ?? "0.001"),
    lot_size: Number(meta?.lotSz ?? "0.1"),
    min_size: Number(meta?.minSz ?? "0.01"),
    state: meta?.state ?? "live",
  };
}

/** Live YES-side order book. Rows arrive as [px, sz, _, orders]. */
export async function fetchEventBook(instId: string): Promise<EventsBook | null> {
  const raw = await get<Array<{ asks?: string[][]; bids?: string[][] }>>(
    `/api/v5/market/books?instId=${encodeURIComponent(instId)}&sz=50`,
    { cache: false }, // sizing needs a fresh book
  );
  const d = raw?.[0];
  if (!d) return null;
  const num = (rows?: string[][]): Array<[number, number]> =>
    (rows ?? []).map((r) => [Number(r[0]), Number(r[1])] as [number, number]);
  const asks = num(d.asks).sort((a, b) => a[0] - b[0]);
  const bids = num(d.bids).sort((a, b) => b[0] - a[0]);
  return { inst_id: instId, best_ask: asks[0]?.[0] ?? null, best_bid: bids[0]?.[0] ?? null, asks, bids };
}

// ── order construction (draft only — the caller submits with their own key) ──
export interface EventOrderDraft {
  // The exact POST /api/v5/trade/order body the caller submits with THEIR OWN
  // OK-ACCESS keys (an exchange API key with trade permission). Optic never submits.
  endpoint: "POST /api/v5/trade/order";
  payload: {
    instId: string;
    tdMode: "cash";
    side: "buy" | "sell";
    ordType: "limit";
    px: string; // decimal string, tick-rounded
    sz: string; // contracts, lot-rounded
  };
  note: string;
}

/**
 * Draft an order against the live book. side yes → the YES contract at/near the ask.
 * side no → the mirror (docs: p(no) = 1 − p(yes)), expressed on the YES book.
 */
export function buildEventDraft(args: {
  contract: EventContract;
  book: EventsBook;
  usdt: number;
  side: "yes" | "no";
  limit?: number;
}): EventOrderDraft | null {
  const { contract: c, book, usdt, side } = args;
  const roundTick = (p: number) => Number((Math.round(p / c.tick_size) * c.tick_size).toFixed(6));
  const clamp = (p: number) => Math.min(1 - c.tick_size, Math.max(c.tick_size, p));

  let apiSide: "buy" | "sell";
  let px: number;
  let rests = false; // true when the needed book side is empty and the order will rest
  if (side === "yes") {
    apiSide = "buy";
    const ask = book.best_ask ?? c.yes_ask;
    if (args.limit !== undefined) px = args.limit;
    else if (ask !== null && ask !== undefined) px = ask;
    else if (book.best_bid !== null) {
      px = book.best_bid + c.tick_size; // no offers: rest one tick above the best bid
      rests = true;
    } else return null; // book empty on both sides — nothing honest to price against
  } else {
    // No = the mirror of Yes: filling at the YES bid is the No entry at 1 − bid.
    apiSide = "sell";
    const bid = book.best_bid ?? c.yes_bid;
    if (args.limit !== undefined) px = 1 - args.limit;
    else if (bid !== null && bid !== undefined) px = bid;
    else if (book.best_ask !== null) {
      px = book.best_ask - c.tick_size; // no bids: rest one tick below the best offer
      rests = true;
    } else return null;
  }
  px = roundTick(clamp(px));
  if (!(px > 0 && px < 1)) return null;

  // size in contracts: notional ≈ px × sz (ctVal=1); round DOWN to the lot grid
  const cost = side === "yes" ? px : 1 - px; // capital at risk per contract
  const rawSz = usdt / cost;
  const sz = Math.floor(rawSz / c.lot_size) * c.lot_size;
  const szR = Number(sz.toFixed(4));
  if (!(szR >= c.min_size)) return null;

  return {
    endpoint: "POST /api/v5/trade/order",
    payload: {
      instId: c.inst_id,
      tdMode: "cash",
      side: apiSide,
      ordType: "limit",
      px: px.toString(),
      sz: szR.toString(),
    },
    note:
      (side === "yes"
        ? "Submit with your own OKX API key (trade permission). Fills as the Yes side of the contract."
        : "No is the mirror of Yes (p_no = 1 − p_yes): this order takes the No side via the Yes book. Submit with your own OKX API key.") +
      (rests ? " The needed side of the book is currently empty, so this order rests at one tick inside the spread rather than filling immediately." : ""),
  };
}
