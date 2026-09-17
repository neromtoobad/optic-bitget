import type { BudgetGuard } from "../pipeline/budget.js";
import { resolveRwaContract, candles, parseCandle, rwaContracts, allTickers, num } from "../lib/bitget/rest.js";
import { cashQuote } from "../lib/yahoo.js";
import { nyEpoch } from "./analogs.js";

// SERIES — what the workbench charts: the perp's hourly closes over the last
// N days, the cash market's daily bars, and the windows the cash market was
// shut, so the chart can shade exactly the hours the perp was the only price.

export interface DeskSeries {
  ticker: string;
  symbol: string;
  perp: Array<{ t: number; close: number; volume: number }>;
  cash: Array<{ date: string; open: number; close: number }>;
  /** Closed-market windows [start, end] in epoch ms, oldest first. */
  closed: Array<[number, number]>;
  from: number;
  to: number;
}

const isWeekday = (d: Date) => d.getUTCDay() >= 1 && d.getUTCDay() <= 5;

export async function deskSeries(ticker: string, days = 7, budget?: BudgetGuard): Promise<DeskSeries | null> {
  const contract = await resolveRwaContract(ticker, budget);
  if (!contract) return null;
  const hours = Math.min(1000, Math.max(24, days * 24));
  const [bars, cash] = await Promise.all([candles(contract.symbol, "1H", hours, budget), cashQuote(ticker, budget, "1mo")]);
  const perp = (bars ?? []).map(parseCandle).filter((b): b is NonNullable<typeof b> => b !== null).map((b) => ({ t: b.ts, close: b.close, volume: b.quoteVolume }));
  if (!perp.length) return null;
  const from = perp[0].t, to = perp[perp.length - 1].t;

  // Closed windows: from each session's 16:00 ET to the next session's 09:30 ET.
  const closed: Array<[number, number]> = [];
  const start = new Date(from - 3 * 86_400_000);
  for (let i = 0; i < days + 6; i++) {
    const d = new Date(start.getTime() + i * 86_400_000);
    const date = d.toISOString().slice(0, 10);
    const open = nyEpoch(date, 9, 30), close = nyEpoch(date, 16, 0);
    if (!isWeekday(d)) {
      closed.push([nyEpoch(date, 0, 0), nyEpoch(date, 23, 59)]);
      continue;
    }
    closed.push([nyEpoch(date, 0, 0), open], [close, nyEpoch(date, 23, 59)]);
  }
  // Merge adjacent windows and clip to the perp range.
  closed.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const w of closed) {
    const last = merged[merged.length - 1];
    if (last && w[0] <= last[1] + 60_000) last[1] = Math.max(last[1], w[1]);
    else merged.push([w[0], w[1]]);
  }
  const clipped = merged.map(([a, b]) => [Math.max(a, from), Math.min(b, to)] as [number, number]).filter(([a, b]) => b > a);

  return {
    ticker: ticker.toUpperCase(),
    symbol: contract.symbol,
    perp,
    cash: (cash?.days ?? []).filter((d) => nyEpoch(d.date, 16, 0) >= from - 86_400_000).map((d) => ({ date: d.date, open: d.open, close: d.close })),
    closed: clipped,
    from,
    to,
  };
}

// WATCH — one row per watchlist name for the landing page: the perp's last
// price, its 24h move, and a 24-point sparkline. One tickers call for all of
// them, then one candles call each (cached 60s by the REST layer).
export interface WatchRow {
  ticker: string;
  symbol: string;
  last: number | null;
  chg_24h_pct: number | null;
  funding_annualized_pct: number | null;
  spark: number[];
}

export async function watchRows(tickers: string[], budget?: BudgetGuard): Promise<WatchRow[]> {
  const [contracts, tickersAll] = await Promise.all([rwaContracts(budget), allTickers(budget)]);
  const bySymbol = new Map((tickersAll ?? []).map((t) => [t.symbol, t]));
  const wanted = tickers
    .map((t) => contracts.find((c) => c.baseCoin.toUpperCase() === t.toUpperCase()))
    .filter((c): c is NonNullable<typeof c> => !!c);
  const out = await Promise.all(
    wanted.map(async (c) => {
      const tk = bySymbol.get(c.symbol);
      const bars = (await candles(c.symbol, "1H", 24, budget).catch(() => null)) ?? [];
      const spark = bars.map(parseCandle).filter((b): b is NonNullable<typeof b> => b !== null).map((b) => b.close);
      const rate = num(tk?.fundingRate);
      const interval = num(c.fundInterval) ?? 8;
      const chg = num(tk?.change24h);
      return {
        ticker: c.baseCoin.toUpperCase(),
        symbol: c.symbol,
        last: num(tk?.lastPr),
        chg_24h_pct: chg === null ? null : Math.round(chg * 10000) / 100,
        funding_annualized_pct: rate === null ? null : Math.round(rate * (24 / interval) * 365 * 100 * 100) / 100,
        spark,
      };
    })
  );
  return out;
}
