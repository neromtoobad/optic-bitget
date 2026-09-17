import { cacheKey, cacheGet, cacheSet } from "../db.js";
import type { BudgetGuard } from "../pipeline/budget.js";

// Cash-market leg — the underlying share, from Yahoo Finance's public chart
// endpoint (no key, no crumb). This is the same substrate Nocturne, the S1
// entry Bitget featured, measured the overnight gap on: the gap only exists on
// the asset that closes. Everything here is computed; the desk cites it, the
// debate never invents it. Bitget's own indexPrice is the live cash reference
// the perp is marked against — this adds the last regular close, the day's
// range, and a short daily history. Session state comes from the clock (see
// lib/bitget/session.ts) — Yahoo's chart meta doesn't carry it.
const BASE = process.env.YAHOO_CHART_BASE ?? "https://query1.finance.yahoo.com";
const TIMEOUT_MS = 15_000;
const MARKET_TTL_S = 60;
const STATIC_TTL_S = 24 * 3600;
// Yahoo refuses the default node UA; a browser-style string is accepted.
const UA = "Mozilla/5.0 (compatible; optic-bitget/1.0)";

export interface CashQuote {
  symbol: string;
  name: string | null;
  exchange: string | null;
  currency: string | null;
  price: number | null; // regular-session last
  previous_close: number | null;
  chg_pct: number | null; // vs previous close
  day_high: number | null;
  day_low: number | null;
  volume: number | null;
  week52_high: number | null;
  week52_low: number | null;
  as_of: string | null; // ISO of regularMarketTime
  /** Daily closes, oldest → newest, for the analog / gap work. */
  closes: Array<{ date: string; close: number }>;
  /** Full daily bars, oldest → newest — the analog engine needs the open to measure the cash gap. */
  days: Array<{ date: string; open: number; high: number; low: number; close: number }>;
}

interface ChartMeta {
  symbol?: string;
  longName?: string;
  shortName?: string;
  exchangeName?: string;
  currency?: string;
  marketState?: string;
  regularMarketPrice?: number;
  chartPreviousClose?: number;
  previousClose?: number;
  regularMarketDayHigh?: number;
  regularMarketDayLow?: number;
  regularMarketVolume?: number;
  regularMarketTime?: number;
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;
}

interface ChartResponse {
  chart?: {
    result?: Array<{ meta?: ChartMeta; timestamp?: number[]; indicators?: { quote?: Array<{ open?: Array<number | null>; high?: Array<number | null>; low?: Array<number | null>; close?: Array<number | null> }> } }>;
    error?: { code?: string; description?: string } | null;
  };
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const round = (x: number | null, p = 2): number | null => (x === null ? null : Math.round(x * 10 ** p) / 10 ** p);

/**
 * Regular-session quote plus a short daily history. Null when Yahoo doesn't
 * know the symbol (cached a day) or is unreachable (never cached).
 */
export async function cashQuote(ticker: string, budget?: BudgetGuard, range: "5d" | "1mo" | "3mo" | "6mo" | "1y" = "1mo"): Promise<CashQuote | null> {
  const sym = ticker.toUpperCase().replace(/[^A-Z0-9.^=-]/g, "");
  if (!sym) return null;
  const url = `${BASE}/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=1d`;
  const key = cacheKey("yahoo:chart", url);
  const hit = cacheGet<CashQuote | null>(key);
  if (hit !== undefined) return hit;
  budget?.register("yahoo:chart", 0); // public data, no per-call cost
  try {
    // One retry on a transport failure — the cash leg is load-bearing and Yahoo
    // is occasionally slow to first byte.
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: "application/json", "User-Agent": UA } });
    } catch {
      res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: "application/json", "User-Agent": UA } });
    }
    if (res.status === 404) {
      cacheSet(key, null, STATIC_TTL_S); // unknown symbol — an honest not-found
      return null;
    }
    if (!res.ok) {
      console.error(`yahoo chart ${sym}: HTTP ${res.status}`);
      return null;
    }
    const json = (await res.json()) as ChartResponse;
    const r = json.chart?.result?.[0];
    if (!r?.meta) {
      if (json.chart?.error) cacheSet(key, null, STATIC_TTL_S);
      return null;
    }
    const m = r.meta;
    const ts = r.timestamp ?? [];
    const q = r.indicators?.quote?.[0] ?? {};
    const closes = q.close ?? [];
    const series: CashQuote["closes"] = [];
    const days: CashQuote["days"] = [];
    for (let i = 0; i < ts.length; i++) {
      const c = closes[i];
      if (typeof c !== "number" || !Number.isFinite(c)) continue;
      const date = new Date(ts[i] * 1000).toISOString().slice(0, 10);
      series.push({ date, close: round(c) ?? c });
      const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i];
      if (typeof o === "number" && typeof h === "number" && typeof l === "number") days.push({ date, open: round(o) ?? o, high: round(h) ?? h, low: round(l) ?? l, close: round(c) ?? c });
    }
    const price = num(m.regularMarketPrice);
    // chartPreviousClose is the close before the *range*, not yesterday's. The
    // last completed session is the last daily bar that isn't today's live bar.
    const asOfDate = m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString().slice(0, 10) : null;
    const last = series[series.length - 1];
    const prevBar = last && asOfDate && last.date === asOfDate ? series[series.length - 2] : last;
    const prev = prevBar?.close ?? num(m.previousClose ?? m.chartPreviousClose);
    const quote: CashQuote = {
      symbol: m.symbol ?? sym,
      name: m.longName ?? m.shortName ?? null,
      exchange: m.exchangeName ?? null,
      currency: m.currency ?? null,
      price: round(price),
      previous_close: round(prev),
      chg_pct: price !== null && prev ? round(((price - prev) / prev) * 100) : null,
      day_high: round(num(m.regularMarketDayHigh)),
      day_low: round(num(m.regularMarketDayLow)),
      volume: num(m.regularMarketVolume),
      week52_high: round(num(m.fiftyTwoWeekHigh)),
      week52_low: round(num(m.fiftyTwoWeekLow)),
      as_of: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : null,
      closes: series,
      days,
    };
    cacheSet(key, quote, MARKET_TTL_S);
    return quote;
  } catch (err) {
    console.error(`yahoo chart ${sym}: ${err}`);
    return null;
  }
}
