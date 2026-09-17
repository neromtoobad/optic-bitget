import type { BudgetGuard } from "../pipeline/budget.js";
import { resolveRwaContract, candles, parseCandle } from "../lib/bitget/rest.js";
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
