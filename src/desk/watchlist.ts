import { kvGet, kvSet } from "../db.js";
import { rwaContracts } from "../lib/bitget/rest.js";

// WATCHLIST — the desk's own daily experiment. After each US cash close the
// desk runs one overnight thesis per name ("hold the perp into tomorrow's
// open") and ledgers it, so the scoreboard fills with rows that resolve at
// the next open: the archive's base rate, and the judge's call when a model
// is configured, graded against what the perp actually did. Nobody has to
// remember to run it; nothing is cherry-picked; every row is public.

export const WATCHLIST = ["NVDA", "AAPL", "TSLA", "MSFT", "AMZN", "GOOGL", "META", "AMD", "MU", "TSM", "COIN", "SPY"];
const KV_LAST = "watchlist:last_run_date"; // NY calendar date of the last run

function nyDate(at = new Date()): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
  return p; // YYYY-MM-DD
}
function nyMinutes(at = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short" }).formatToParts(at);
  const get = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
  if (get("weekday") === "Sat" || get("weekday") === "Sun") return -1;
  return (Number(get("hour")) % 24) * 60 + Number(get("minute"));
}

export const thesisFor = (ticker: string) => `Long ${ticker} perp overnight into tomorrow's US open`;

let running = false;

/**
 * Run the watchlist once per NY trading day, in the window after the cash
 * close (16:05–19:00 ET). Idempotent: the last run date is kept in kv. Names
 * Bitget doesn't list are skipped. Sequential on purpose — one process, one DB.
 */
export async function maybeRunWatchlist(runRead: (q: string, opts: { forceMode: "desk" }) => Promise<unknown>, force = false): Promise<{ ran: boolean; reason: string; count?: number }> {
  if (running) return { ran: false, reason: "already running" };
  const today = nyDate();
  const mins = nyMinutes();
  if (!force) {
    if (mins < 0) return { ran: false, reason: "weekend" };
    if (mins < 16 * 60 + 5 || mins > 19 * 60) return { ran: false, reason: "outside the post-close window" };
    if (kvGet<string>(KV_LAST) === today) return { ran: false, reason: "already ran today" };
  }
  running = true;
  try {
    const listed = new Set((await rwaContracts()).map((c) => c.baseCoin.toUpperCase()));
    let count = 0;
    for (const t of WATCHLIST) {
      if (!listed.has(t)) continue;
      try {
        await runRead(thesisFor(t), { forceMode: "desk" });
        count++;
      } catch (err) {
        console.error(`watchlist ${t}: ${err}`);
      }
    }
    kvSet(KV_LAST, today);
    return { ran: true, reason: "ok", count };
  } finally {
    running = false;
  }
}

export function watchlistStatus(): { names: string[]; last_run_date: string | null; window_et: string } {
  return { names: WATCHLIST, last_run_date: kvGet<string>(KV_LAST) ?? null, window_et: "16:05–19:00" };
}
