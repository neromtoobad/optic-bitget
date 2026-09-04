import { cacheKey, cacheGet, cacheSet } from "../../db.js";
import type { BudgetGuard } from "../../pipeline/budget.js";

// Binance public market data — the REST face of the same data the Binance MCP
// Server exposes (tickers, candles, funding, open interest). Free, no key. Used
// as the fallback path for the CEX lens when the MCP session is not authorised,
// and for the derivatives positioning series the MCP server does not carry.
// Spot market data comes from Binance's public data-only host: same /api/v3 surface,
// not subject to the jurisdiction block (HTTP 451) that api.binance.com applies to
// US-region hosts such as Railway's sfo. Futures data has no such twin.
const SPOT = process.env.BINANCE_SPOT_DATA_BASE ?? "https://data-api.binance.vision";
const FAPI = process.env.BINANCE_FAPI_BASE ?? "https://fapi.binance.com";
const TIMEOUT_MS = 10_000;
// Market data moves; keep the cache short so a read is never stale by minutes.
const MARKET_TTL_S = 60;
const STATIC_TTL_S = 24 * 3600;

export class BinanceRestError extends Error {
  constructor(public readonly endpoint: string, public readonly status: number, msg: string) {
    super(`binance ${endpoint}: HTTP ${status} ${msg}`);
    this.name = "BinanceRestError";
  }
}

async function get<T>(endpoint: string, url: string, opts: { budget?: BudgetGuard; ttl?: number } = {}): Promise<T | null> {
  const key = cacheKey(`binance:${endpoint}`, url);
  const hit = cacheGet<T | null>(key);
  if (hit !== undefined) return hit;
  opts.budget?.register(`binance:${endpoint}`, 0); // public data, no per-call cost
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: "application/json" } });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // A 400 on a symbol lookup is the honest "not listed" — cache it too so a
      // repeated unknown ticker doesn't hammer the API. A 451 is a geo block on
      // this host, not a fact about the symbol: never cache it.
      if (res.status === 400) {
        cacheSet(key, null, STATIC_TTL_S);
        return null;
      }
      console.error(new BinanceRestError(endpoint, res.status, text.slice(0, 120)).message);
      return null;
    }
    const json = (await res.json()) as T;
    cacheSet(key, json, opts.ttl ?? MARKET_TTL_S);
    return json;
  } catch (err) {
    console.error(`binance ${endpoint}: ${err}`);
    return null;
  }
}

export const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

// ── spot ──────────────────────────────────────────────────────────────

export interface Ticker24h {
  symbol: string;
  lastPrice: string;
  priceChangePercent: string;
  quoteVolume: string;
  volume: string;
  highPrice: string;
  lowPrice: string;
  weightedAvgPrice: string;
}

export function spotTicker24h(symbol: string, budget?: BudgetGuard) {
  return get<Ticker24h>("spot_ticker_24h", `${SPOT}/api/v3/ticker/24hr?symbol=${encodeURIComponent(symbol)}`, { budget });
}

/** Does Binance list this spot pair? (cached a day; a 400 = not listed) */
export async function spotSymbolInfo(symbol: string, budget?: BudgetGuard) {
  const info = await get<{ symbols?: Array<{ symbol: string; status: string; baseAsset: string; quoteAsset: string }> }>(
    "spot_exchange_info",
    `${SPOT}/api/v3/exchangeInfo?symbol=${encodeURIComponent(symbol)}`,
    { budget, ttl: STATIC_TTL_S }
  );
  const s = info?.symbols?.[0];
  return s && s.status === "TRADING" ? s : null;
}

/** Spot candles: [openTime, open, high, low, close, volume, closeTime, quoteVolume, trades, ...] */
export function spotKlines(symbol: string, interval: string, limit: number, budget?: BudgetGuard) {
  return get<Array<[number, string, string, string, string, string, number, string, number]>>(
    "spot_klines",
    `${SPOT}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`,
    { budget }
  );
}

// ── USDⓈ-M perps ──────────────────────────────────────────────────────

export function futuresPremiumIndex(symbol: string, budget?: BudgetGuard) {
  return get<{ markPrice: string; indexPrice: string; lastFundingRate: string; nextFundingTime: number }>(
    "fut_premium_index",
    `${FAPI}/fapi/v1/premiumIndex?symbol=${encodeURIComponent(symbol)}`,
    { budget }
  );
}

export function futuresOpenInterest(symbol: string, budget?: BudgetGuard) {
  return get<{ openInterest: string; time: number }>("fut_open_interest", `${FAPI}/fapi/v1/openInterest?symbol=${encodeURIComponent(symbol)}`, { budget });
}

/** Open-interest history (value in USDT) — 1h buckets; 25 points ≈ 24h. */
export function futuresOpenInterestHist(symbol: string, budget?: BudgetGuard, limit = 25) {
  return get<Array<{ sumOpenInterest: string; sumOpenInterestValue: string; timestamp: number }>>(
    "fut_oi_hist",
    `${FAPI}/futures/data/openInterestHist?symbol=${encodeURIComponent(symbol)}&period=1h&limit=${limit}`,
    { budget }
  );
}

export function futuresLongShortRatio(symbol: string, budget?: BudgetGuard) {
  return get<Array<{ longShortRatio: string; longAccount: string; shortAccount: string; timestamp: number }>>(
    "fut_long_short",
    `${FAPI}/futures/data/globalLongShortAccountRatio?symbol=${encodeURIComponent(symbol)}&period=1h&limit=1`,
    { budget }
  );
}

export function futuresTakerRatio(symbol: string, budget?: BudgetGuard) {
  return get<Array<{ buySellRatio: string; buyVol: string; sellVol: string; timestamp: number }>>(
    "fut_taker_ratio",
    `${FAPI}/futures/data/takerlongshortRatio?symbol=${encodeURIComponent(symbol)}&period=1h&limit=1`,
    { budget }
  );
}
