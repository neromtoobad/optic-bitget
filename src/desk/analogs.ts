import { readFileSync, existsSync } from "node:fs";
import { historyCandles, parseCandle, type Bar, type Candle } from "../lib/bitget/rest.js";
import type { CashQuote } from "../lib/yahoo.js";
import type { BudgetGuard } from "../pipeline/budget.js";

// ANALOGS — the historical distribution behind a thesis, computed from
// Bitget's own hourly archive of the perpetual. This is the desk's centrepiece
// and the thing only Bitget data can produce: an rToken perp trades through
// every window the cash market is shut, so for any thesis we can find the
// comparable windows in its history and report what the perp actually did —
// hit rate for the thesis's direction, median and tail moves, the cash gap it
// was pricing, and where the perp sat against the cash open. No model touches
// this. The Laplace-smoothed hit rate is the BASE RATE the judge is scored
// against on the scoreboard: does the debate beat history?

export type WindowKind = "overnight" | "weekend" | "earnings" | "session";

export interface AnalogWindow {
  kind: WindowKind;
  entry_at: string; // ISO
  exit_at: string;
  entry_perp: number;
  exit_perp: number;
  perp_move_pct: number;
  /** Cash gap the window contained: next open vs prior close. Null for session windows. */
  cash_gap_pct: number | null;
  /** Perp at the cash open vs the cash open print — the residual the perp got wrong. */
  perp_vs_cash_open_pct: number | null;
  event_date?: string; // earnings date, for earnings windows
}

export interface AnalogStats {
  kind: WindowKind;
  horizon_hours: number;
  direction: "up" | "down" | "neutral";
  n: number;
  /** Share of windows the perp moved the thesis's way. Null for neutral. */
  hit_rate: number | null;
  /** Laplace-smoothed hit rate — the base-rate P(holds) the judge is compared with. */
  base_rate_p: number | null;
  median_move_pct: number;
  mean_move_pct: number;
  p10_move_pct: number;
  p90_move_pct: number;
  worst_against_pct: number | null; // the worst move against the thesis's direction
  best_for_pct: number | null;
  mean_abs_move_pct: number;
  /** How the cash market gapped over the same windows. */
  cash_gap: { n: number; median_pct: number; mean_abs_pct: number } | null;
  /** Residual between the perp and the cash open at the moment cash reopened. */
  perp_vs_cash_open: { n: number; median_pct: number; mean_abs_pct: number } | null;
  /** Cost of holding the perp through the horizon at the current funding rate (positive = longs pay). */
  funding_cost_pct: number | null;
  windows: AnalogWindow[]; // most recent first, capped
  history_from: string | null;
  history_to: string | null;
  source: "archive" | "live";
}

const NY = "America/New_York";

/** Epoch ms for HH:MM in New York on a calendar date, DST-correct. */
export function nyEpoch(date: string, hh: number, mm: number): number {
  const guess = Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), hh, mm);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: NY, hour: "2-digit", minute: "2-digit", hour12: false, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(guess));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"));
  return guess - (asUtc - guess);
}

const isWeekday = (date: string) => {
  const d = new Date(`${date}T12:00:00Z`).getUTCDay();
  return d >= 1 && d <= 5;
};
const addDays = (date: string, n: number) => new Date(new Date(`${date}T12:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);

/** Load the archived hourly bars for a symbol (data/history/), else pull what the API gives. */
export async function loadBars(symbol: string, budget?: BudgetGuard): Promise<{ bars: Bar[]; source: AnalogStats["source"] }> {
  const path = `data/history/${symbol}.json`;
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Candle[];
      const bars = raw.map(parseCandle).filter((b): b is Bar => b !== null);
      if (bars.length > 100) return { bars, source: "archive" };
    } catch {
      /* fall through to live */
    }
  }
  // Live: walk back up to ten pages (≈ 2000 bars ≈ 83 days).
  const all = new Map<number, Bar>();
  let end: number | undefined;
  for (let i = 0; i < 10; i++) {
    const page = (await historyCandles(symbol, "1H", 200, end, budget)) ?? [];
    if (!page.length) break;
    for (const c of page) {
      const b = parseCandle(c);
      if (b) all.set(b.ts, b);
    }
    end = Number(page[0][0]);
    if (page.length < 200) break;
  }
  return { bars: [...all.values()].sort((a, b) => a.ts - b.ts), source: "live" };
}

/** The last bar at or before `ts`, within 3 hours. */
function barAt(bars: Bar[], ts: number): Bar | null {
  let lo = 0, hi = bars.length - 1, best: Bar | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].ts <= ts) { best = bars[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  return best && ts - best.ts <= 3 * 3600_000 ? best : null;
}

const pct = (a: number, b: number) => ((b - a) / a) * 100;
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return NaN;
  const i = (s.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
};

/** Classify the thesis window from its wording and horizon. */
export function classifyWindow(thesis: string, horizonHours: number, hasEarningsSoon: boolean): WindowKind {
  const t = thesis.toLowerCase();
  if (/earnings|print|report|results|guidance/.test(t) || hasEarningsSoon) return "earnings";
  if (/weekend|friday|monday/.test(t)) return "weekend";
  if (/overnight|tonight|after.?hours|pre.?market|into the open|at the open/.test(t) || horizonHours <= 20) return "overnight";
  return "session";
}

/**
 * Find every comparable window in the archive and measure it. Overnight: cash
 * close (16:00 ET) → next cash open (09:30 ET) on consecutive weekdays. Weekend:
 * Friday close → Monday open. Earnings: the close before the print → the open
 * after it, one window per past release date. Session: rolling windows of the
 * thesis's horizon, sampled at each cash open.
 */
export function analogWindows(bars: Bar[], cash: CashQuote | null, kind: WindowKind, horizonHours: number, pastEarnings: string[] = []): AnalogWindow[] {
  if (bars.length < 24) return [];
  const first = bars[0].ts, last = bars[bars.length - 1].ts;
  const cashByDate = new Map((cash?.days ?? []).map((d) => [d.date, d]));
  const out: AnalogWindow[] = [];
  const dates: string[] = [];
  for (let t = first; t <= last; t += 86_400_000) dates.push(new Date(t).toISOString().slice(0, 10));

  const measure = (kindOf: WindowKind, entryTs: number, exitTs: number, closeDate: string | null, openDate: string | null, eventDate?: string) => {
    const e = barAt(bars, entryTs), x = barAt(bars, exitTs);
    if (!e || !x || exitTs <= entryTs) return;
    const prior = closeDate ? cashByDate.get(closeDate) : undefined;
    const next = openDate ? cashByDate.get(openDate) : undefined;
    const w: AnalogWindow = {
      kind: kindOf,
      entry_at: new Date(entryTs).toISOString(),
      exit_at: new Date(exitTs).toISOString(),
      entry_perp: e.close,
      exit_perp: x.close,
      perp_move_pct: r3(pct(e.close, x.close)),
      cash_gap_pct: prior && next ? r3(pct(prior.close, next.open)) : null,
      perp_vs_cash_open_pct: next ? r3(pct(next.open, x.close)) : null,
      ...(eventDate ? { event_date: eventDate } : {}),
    };
    out.push(w);
  };

  if (kind === "overnight" || kind === "weekend") {
    for (const d of dates) {
      if (!isWeekday(d)) continue;
      const nextDay = kind === "weekend" ? addDays(d, 3) : addDays(d, 1);
      const isFri = new Date(`${d}T12:00:00Z`).getUTCDay() === 5;
      if (kind === "weekend" && !isFri) continue;
      if (kind === "overnight" && isFri) continue;
      if (!isWeekday(nextDay)) continue;
      measure(kind, nyEpoch(d, 16, 0), nyEpoch(nextDay, 9, 30), d, nextDay);
    }
  } else if (kind === "earnings") {
    for (const ev of pastEarnings) {
      // Filed date ≈ release date. Entry: the close before the print (the release day's close for
      // after-hours reporters is the entry; pre-market reporters' prior close). Exit: the open after.
      const exitDay = addDays(ev, 1);
      const openDay = isWeekday(exitDay) ? exitDay : addDays(exitDay, exitDay === addDays(ev, 1) && new Date(`${exitDay}T12:00:00Z`).getUTCDay() === 6 ? 2 : 1);
      measure("earnings", nyEpoch(ev, 16, 0), nyEpoch(openDay, 9, 30), ev, openDay, ev);
    }
  } else {
    const h = Math.max(1, Math.round(horizonHours));
    for (const d of dates) {
      if (!isWeekday(d)) continue;
      const entry = nyEpoch(d, 9, 30);
      measure("session", entry, entry + h * 3600_000, null, null);
    }
  }
  return out.filter((w) => Number.isFinite(w.perp_move_pct)).sort((a, b) => b.entry_at.localeCompare(a.entry_at));
}

export function summarize(windows: AnalogWindow[], kind: WindowKind, horizonHours: number, direction: AnalogStats["direction"], fundingRate: number | null, fundingIntervalH: number | null, meta: { from: string | null; to: string | null; source: AnalogStats["source"] }): AnalogStats {
  const moves = windows.map((w) => w.perp_move_pct);
  const sign = direction === "up" ? 1 : direction === "down" ? -1 : 0;
  const hits = sign ? windows.filter((w) => Math.sign(w.perp_move_pct) === sign).length : 0;
  const against = sign ? moves.map((m) => m * sign).filter((m) => m < 0) : [];
  const forr = sign ? moves.map((m) => m * sign).filter((m) => m > 0) : [];
  const gaps = windows.map((w) => w.cash_gap_pct).filter((g): g is number => g !== null);
  const resid = windows.map((w) => w.perp_vs_cash_open_pct).filter((g): g is number => g !== null);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
  const intervals = fundingIntervalH ? horizonHours / fundingIntervalH : null;
  return {
    kind,
    horizon_hours: horizonHours,
    direction,
    n: windows.length,
    hit_rate: sign && windows.length ? r3(hits / windows.length) : null,
    base_rate_p: sign ? r3((hits + 1) / (windows.length + 2)) : null,
    median_move_pct: r3(quantile(moves, 0.5)),
    mean_move_pct: r3(mean(moves)),
    p10_move_pct: r3(quantile(moves, 0.1)),
    p90_move_pct: r3(quantile(moves, 0.9)),
    worst_against_pct: against.length ? r3(Math.min(...against)) : sign ? 0 : null,
    best_for_pct: forr.length ? r3(Math.max(...forr)) : sign ? 0 : null,
    mean_abs_move_pct: r3(mean(moves.map(Math.abs))),
    cash_gap: gaps.length ? { n: gaps.length, median_pct: r3(quantile(gaps, 0.5)), mean_abs_pct: r3(mean(gaps.map(Math.abs))) } : null,
    perp_vs_cash_open: resid.length ? { n: resid.length, median_pct: r3(quantile(resid, 0.5)), mean_abs_pct: r3(mean(resid.map(Math.abs))) } : null,
    // Longs pay positive funding; the thesis's side decides the sign of the cost.
    funding_cost_pct: fundingRate !== null && intervals !== null ? r3(fundingRate * intervals * 100 * (direction === "down" ? -1 : 1)) : null,
    windows: windows.slice(0, 12),
    history_from: meta.from,
    history_to: meta.to,
    source: meta.source,
  };
}

/** The whole thing: archive → windows → stats. */
export async function analogsFor(opts: { symbol: string; thesis: string; direction: AnalogStats["direction"]; horizonHours: number; cash: CashQuote | null; pastEarnings: string[]; hasEarningsSoon: boolean; fundingRate: number | null; fundingIntervalH: number | null; budget?: BudgetGuard }): Promise<AnalogStats | null> {
  const { bars, source } = await loadBars(opts.symbol, opts.budget);
  if (bars.length < 24) return null;
  const kind = classifyWindow(opts.thesis, opts.horizonHours, opts.hasEarningsSoon);
  const windows = analogWindows(bars, opts.cash, kind, opts.horizonHours, opts.pastEarnings);
  if (!windows.length) return null;
  return summarize(windows, kind, opts.horizonHours, opts.direction, opts.fundingRate, opts.fundingIntervalH, {
    from: new Date(bars[0].ts).toISOString().slice(0, 10),
    to: new Date(bars[bars.length - 1].ts).toISOString().slice(0, 10),
    source,
  });
}
