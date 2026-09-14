import { config } from "../../config.js";
import { cacheKey, cacheGet, cacheSet } from "../../db.js";
import type { BudgetGuard } from "../../pipeline/budget.js";

// Bitget public futures market data — the REST face of the USDT-FUTURES data
// Bitget Agent Hub's `market` verb exposes (tickers, candles, funding, open
// interest). Free, no key, and no Trade permission anywhere in this file.
// Bitget's tokenized US stocks (rToken) trade here as perpetuals — NVDAUSDT,
// AAPLUSDT, SP500USDT… — and the contract list flags them `isRwa`, so the desk
// discovers the tradable universe at runtime instead of hardcoding a ticker list.
const BASE = config.bitget.restBase;
const PRODUCT = "USDT-FUTURES";
const TIMEOUT_MS = 10_000;
// Market data moves; keep the cache short so a read is never stale by minutes.
const MARKET_TTL_S = 60;
const STATIC_TTL_S = 24 * 3600;

export class BitgetRestError extends Error {
  constructor(public readonly endpoint: string, public readonly code: string, msg: string) {
    super(`bitget ${endpoint}: code=${code} ${msg}`);
    this.name = "BitgetRestError";
  }
}

/**
 * Cache-first, budget-registered Bitget v2 call. Every response is wrapped as
 * {code, msg, data}; "00000" is success. Returns `data`, or null on any failure —
 * lenses never throw through the pipeline.
 */
async function get<T>(endpoint: string, path: string, opts: { budget?: BudgetGuard; ttl?: number } = {}): Promise<T | null> {
  const url = `${BASE}${path}`;
  const key = cacheKey(`bitget:${endpoint}`, url);
  const hit = cacheGet<T | null>(key);
  if (hit !== undefined) return hit;
  opts.budget?.register(`bitget:${endpoint}`, 0); // public data, no per-call cost
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: "application/json" } });
    const json = (await res.json().catch(() => null)) as { code?: string; msg?: string; data?: T } | null;
    if (!res.ok || !json || json.code !== "00000") {
      const code = json?.code ?? String(res.status);
      const msg = json?.msg ?? "";
      // "does not exist" on a symbol lookup is the honest "not listed" — cache it
      // a day so a repeated unknown ticker doesn't hammer the API. Anything else
      // (rate limit, outage) is not a fact about the symbol: never cache it.
      if (/not exist/i.test(msg)) {
        cacheSet(key, null, STATIC_TTL_S);
        return null;
      }
      console.error(new BitgetRestError(endpoint, code, msg.slice(0, 120)).message);
      return null;
    }
    const data = json.data ?? null;
    cacheSet(key, data, opts.ttl ?? MARKET_TTL_S);
    return data;
  } catch (err) {
    console.error(`bitget ${endpoint}: ${err}`);
    return null;
  }
}

export const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

const enc = encodeURIComponent;

// ── contracts ─────────────────────────────────────────────────────────

export interface Contract {
  symbol: string; // NVDAUSDT
  baseCoin: string; // NVDA
  quoteCoin: string; // USDT
  symbolType: string; // "perpetual"
  symbolStatus: string; // "normal" when tradable
  isRwa?: "YES" | "NO"; // tokenized real-world asset (US stock / index / metal)
  fundInterval?: string; // hours between funding settlements ("8")
  minLever?: string;
  maxLever?: string;
  makerFeeRate?: string;
  takerFeeRate?: string;
  pricePlace?: string;
  volumePlace?: string;
  minTradeUSDT?: string;
  openTime?: string;
}

/** Every USDT-margined perpetual Bitget lists (cached a day). */
export function contracts(budget?: BudgetGuard) {
  return get<Contract[]>("contracts", `/api/v2/mix/market/contracts?productType=${PRODUCT}`, { budget, ttl: STATIC_TTL_S });
}

/** The tokenized real-world-asset perpetuals — contracts Bitget flags isRwa and lists as tradable. */
export async function rwaContracts(budget?: BudgetGuard): Promise<Contract[]> {
  const all = (await contracts(budget)) ?? [];
  return all.filter((c) => c.isRwa === "YES" && c.symbolStatus === "normal");
}

/** NVDA → the NVDAUSDT contract, or null when Bitget lists no rToken future for the ticker. */
export async function resolveRwaContract(ticker: string, budget?: BudgetGuard): Promise<Contract | null> {
  const want = ticker.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!want) return null;
  const list = await rwaContracts(budget);
  return list.find((c) => c.baseCoin.toUpperCase() === want) ?? null;
}

// ── market ────────────────────────────────────────────────────────────

export interface Ticker {
  symbol: string;
  lastPr: string;
  askPr: string;
  bidPr: string;
  high24h: string;
  low24h: string;
  open24h: string;
  openUtc: string;
  change24h: string; // fraction, e.g. "-0.0159"
  changeUtc24h: string;
  baseVolume: string;
  quoteVolume: string;
  usdtVolume: string;
  indexPrice: string; // the underlying's reference price
  markPrice: string;
  fundingRate: string; // current rate per interval, fraction
  holdingAmount: string; // open interest, in contracts
  ts: string;
}

export async function ticker(symbol: string, budget?: BudgetGuard): Promise<Ticker | null> {
  const d = await get<Ticker[]>("ticker", `/api/v2/mix/market/ticker?symbol=${enc(symbol)}&productType=${PRODUCT}`, { budget });
  return d?.[0] ?? null;
}

export interface FundRate {
  symbol: string;
  fundingRate: string;
  fundingRateInterval: string; // hours
  nextUpdate: string; // ms epoch
  minFundingRate: string;
  maxFundingRate: string;
}

export async function currentFundRate(symbol: string, budget?: BudgetGuard): Promise<FundRate | null> {
  const d = await get<FundRate[]>("current_fund_rate", `/api/v2/mix/market/current-fund-rate?symbol=${enc(symbol)}&productType=${PRODUCT}`, { budget });
  return d?.[0] ?? null;
}

/** Settled funding history, newest first. 24 points ≈ 8 days at the 8h interval. */
export function historyFundRate(symbol: string, budget?: BudgetGuard, pageSize = 24) {
  return get<Array<{ symbol: string; fundingRate: string; fundingTime: string }>>(
    "history_fund_rate",
    `/api/v2/mix/market/history-fund-rate?symbol=${enc(symbol)}&productType=${PRODUCT}&pageSize=${pageSize}`,
    { budget }
  );
}

export async function openInterest(symbol: string, budget?: BudgetGuard): Promise<{ size: number | null; ts: number | null } | null> {
  const d = await get<{ openInterestList?: Array<{ symbol: string; size: string }>; ts?: string }>(
    "open_interest",
    `/api/v2/mix/market/open-interest?symbol=${enc(symbol)}&productType=${PRODUCT}`,
    { budget }
  );
  if (!d) return null;
  return { size: num(d.openInterestList?.[0]?.size), ts: num(d.ts) };
}

export type Granularity = "1m" | "5m" | "15m" | "30m" | "1H" | "4H" | "6H" | "12H" | "1D" | "1W";
/** [ts, open, high, low, close, baseVolume, quoteVolume] — all strings, ascending by ts. */
export type Candle = [string, string, string, string, string, string, string];

/** Recent candles, ascending. Bitget caps `limit` at 1000. */
export function candles(symbol: string, granularity: Granularity, limit: number, budget?: BudgetGuard) {
  return get<Candle[]>(
    "candles",
    `/api/v2/mix/market/candles?symbol=${enc(symbol)}&granularity=${granularity}&productType=${PRODUCT}&limit=${Math.min(limit, 1000)}`,
    { budget }
  );
}

/**
 * Deep history, one page at a time (Bitget caps a page at 200). Pass the oldest
 * ts of the previous page as `endTime` to walk backwards — the same pagination
 * the 166-day rToken bar set was pulled with.
 */
export function historyCandles(symbol: string, granularity: Granularity, limit: number, endTime?: number, budget?: BudgetGuard) {
  const tail = endTime === undefined ? "" : `&endTime=${endTime}`;
  return get<Candle[]>(
    "history_candles",
    `/api/v2/mix/market/history-candles?symbol=${enc(symbol)}&granularity=${granularity}&productType=${PRODUCT}&limit=${Math.min(limit, 200)}${tail}`,
    { budget, ttl: STATIC_TTL_S }
  );
}

export interface Bar {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume: number;
}

export function parseCandle(c: Candle): Bar | null {
  const [ts, o, h, l, cl, v, qv] = c.map(num);
  if (ts === null || o === null || h === null || l === null || cl === null) return null;
  return { ts, open: o, high: h, low: l, close: cl, volume: v ?? 0, quoteVolume: qv ?? 0 };
}
