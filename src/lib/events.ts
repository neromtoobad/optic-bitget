import { cacheKey, cacheGet, cacheSet } from "../db.js";
import type { BudgetGuard } from "../pipeline/budget.js";

// Events — the dated facts a thesis lives around, from two official/free
// sources: SEC EDGAR for what has already been filed (an 8-K with item 2.02
// is an earnings release — exact, historical, no vendor), and Nasdaq's public
// earnings calendar for what is scheduled. No key, no model.
const UA = "Mozilla/5.0 (compatible; optic-bitget/1.0)";
// EDGAR asks for a descriptive UA with a contact; it throttles anonymous ones.
const SEC_UA = "optic-bitget research desk (dimejikeji5@gmail.com)";
const TIMEOUT_MS = 12_000;
const DAY_S = 24 * 3600;

async function getJson<T>(url: string, endpoint: string, ua: string, ttl: number, budget?: BudgetGuard): Promise<T | null> {
  const key = cacheKey(`events:${endpoint}`, url);
  const hit = cacheGet<T | null>(key);
  if (hit !== undefined) return hit;
  budget?.register(`events:${endpoint}`, 0);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { "User-Agent": ua, Accept: "application/json" } });
    if (!res.ok) {
      console.error(`events ${endpoint}: HTTP ${res.status}`);
      return null;
    }
    const json = (await res.json()) as T;
    cacheSet(key, json, ttl);
    return json;
  } catch (err) {
    console.error(`events ${endpoint}: ${err}`);
    return null;
  }
}

// ── SEC EDGAR ─────────────────────────────────────────────────────────

type TickerMap = Record<string, { cik_str: number; ticker: string; title: string }>;

export async function cikFor(ticker: string, budget?: BudgetGuard): Promise<{ cik: string; name: string } | null> {
  const map = await getJson<TickerMap>("https://www.sec.gov/files/company_tickers.json", "sec_tickers", SEC_UA, DAY_S, budget);
  if (!map) return null;
  const want = ticker.toUpperCase();
  for (const v of Object.values(map)) if (v.ticker?.toUpperCase() === want) return { cik: String(v.cik_str).padStart(10, "0"), name: v.title };
  return null;
}

export interface Filing {
  form: string;
  filed: string; // YYYY-MM-DD
  items: string | null; // 8-K items, e.g. "2.02,9.01"
  description: string | null;
  url: string;
}

interface Submissions {
  name?: string;
  filings?: { recent?: { form?: string[]; filingDate?: string[]; items?: string[]; primaryDocDescription?: string[]; accessionNumber?: string[]; primaryDocument?: string[] } };
}

/** Recent SEC filings (8-K, 10-Q, 10-K), newest first. */
export async function filings(ticker: string, budget?: BudgetGuard, limit = 12): Promise<{ name: string; filings: Filing[] } | null> {
  const id = await cikFor(ticker, budget);
  if (!id) return null;
  const sub = await getJson<Submissions>(`https://data.sec.gov/submissions/CIK${id.cik}.json`, "sec_submissions", SEC_UA, 6 * 3600, budget);
  const r = sub?.filings?.recent;
  if (!r?.form) return null;
  const out: Filing[] = [];
  for (let i = 0; i < r.form.length && out.length < limit; i++) {
    const form = r.form[i];
    if (!["8-K", "10-Q", "10-K"].includes(form)) continue;
    const acc = (r.accessionNumber?.[i] ?? "").replace(/-/g, "");
    out.push({
      form,
      filed: r.filingDate?.[i] ?? "",
      items: r.items?.[i] || null,
      description: r.primaryDocDescription?.[i] || null,
      url: `https://www.sec.gov/Archives/edgar/data/${Number(id.cik)}/${acc}/${r.primaryDocument?.[i] ?? ""}`,
    });
  }
  return { name: sub?.name ?? id.name, filings: out };
}

/** Past earnings releases: 8-K filings carrying item 2.02 (Results of Operations). */
export async function pastEarningsDates(ticker: string, budget?: BudgetGuard): Promise<string[]> {
  const id = await cikFor(ticker, budget);
  if (!id) return [];
  const sub = await getJson<Submissions>(`https://data.sec.gov/submissions/CIK${id.cik}.json`, "sec_submissions", SEC_UA, 6 * 3600, budget);
  const r = sub?.filings?.recent;
  if (!r?.form) return [];
  const dates: string[] = [];
  for (let i = 0; i < r.form.length; i++) if (r.form[i] === "8-K" && /(^|,)2\.02(,|$)/.test(r.items?.[i] ?? "")) dates.push(r.filingDate?.[i] ?? "");
  return [...new Set(dates.filter(Boolean))].sort().reverse();
}

// ── Nasdaq earnings calendar ──────────────────────────────────────────

interface NasdaqCal { data?: { rows?: Array<{ symbol?: string; name?: string; time?: string; epsForecast?: string; lastYearEPS?: string }> } }

function* weekdays(from: Date, days: number): Generator<string> {
  for (let i = 0; i < days; i++) {
    const d = new Date(from.getTime() + i * 86_400_000);
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    yield d.toISOString().slice(0, 10);
  }
}

export interface UpcomingEarnings {
  date: string;
  time: string | null; // pre-market | after-hours | not supplied
  eps_forecast: string | null;
}

/**
 * The next scheduled earnings date for a ticker, scanning the public calendar
 * day by day (cached 12h per day, five requests in flight). Null when nothing is
 * scheduled in the window — which is itself a fact the desk can cite.
 */
export async function upcomingEarnings(ticker: string, budget?: BudgetGuard, days = 45): Promise<UpcomingEarnings | null> {
  const want = ticker.toUpperCase();
  const dates = [...weekdays(new Date(), days)];
  for (let i = 0; i < dates.length; i += 5) {
    const batch = dates.slice(i, i + 5);
    const pages = await Promise.all(batch.map((d) => getJson<NasdaqCal>(`https://api.nasdaq.com/api/calendar/earnings?date=${d}`, "nasdaq_cal", UA, 12 * 3600, budget)));
    for (let j = 0; j < batch.length; j++) {
      const row = pages[j]?.data?.rows?.find((r) => r.symbol?.toUpperCase() === want);
      if (row) return { date: batch[j], time: row.time && row.time !== "time-not-supplied" ? row.time.replace("time-", "") : null, eps_forecast: row.epsForecast || null };
    }
  }
  return null;
}
