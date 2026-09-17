import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { historyCandles, candles, type Candle } from "../lib/bitget/rest.js";
import { kvGet, kvSet } from "../db.js";

// ARCHIVE — the perp's full hourly history, on disk, from its listing date to
// now. Built once at boot for the watchlist (paging back until Bitget's
// archive runs out), extended forward daily, and read by the analog engine.
// On Railway HISTORY_DIR points at the mounted volume so a redeploy doesn't
// re-page a year of bars. Rate-limited and sequential: this is a courtesy
// crawl of a public endpoint, not a race.

export const HISTORY_DIR = process.env.HISTORY_DIR ?? "data/history";
const PAGE = 200;
const MAX_PAGES_BACK = 120; // ≈ 24,000 bars ≈ 2.7 years — more than any rToken has
const PAUSE_MS = 150;
const KV_LAST = "archive:last_extend_date";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pathFor = (symbol: string) => `${HISTORY_DIR}/${symbol}.json`;

function load(symbol: string): Map<number, Candle> {
  const p = pathFor(symbol);
  if (!existsSync(p)) return new Map();
  try {
    return new Map((JSON.parse(readFileSync(p, "utf8")) as Candle[]).map((c) => [Number(c[0]), c]));
  } catch {
    return new Map();
  }
}

function save(symbol: string, rows: Map<number, Candle>): number {
  mkdirSync(HISTORY_DIR, { recursive: true });
  const out = [...rows.keys()].sort((a, b) => a - b).map((k) => rows.get(k)!);
  writeFileSync(pathFor(symbol), JSON.stringify(out));
  return out.length;
}

/** Page backwards from the oldest bar on disk until Bitget has nothing older. */
export async function backfill(symbol: string): Promise<{ bars: number; added: number }> {
  const rows = load(symbol);
  let end: number | undefined = rows.size ? Math.min(...rows.keys()) : undefined;
  let added = 0;
  for (let i = 0; i < MAX_PAGES_BACK; i++) {
    const page = (await historyCandles(symbol, "1H", PAGE, end)) ?? [];
    if (!page.length) break;
    for (const c of page) if (!rows.has(Number(c[0]))) { rows.set(Number(c[0]), c); added++; }
    end = Number(page[0][0]);
    if (page.length < PAGE) break;
    await sleep(PAUSE_MS);
  }
  return { bars: added ? save(symbol, rows) : rows.size, added };
}

/** Pull the most recent bars and append anything newer than what's on disk. */
export async function extend(symbol: string): Promise<{ bars: number; added: number }> {
  const rows = load(symbol);
  const recent = (await candles(symbol, "1H", 1000)) ?? [];
  let added = 0;
  for (const c of recent) if (!rows.has(Number(c[0]))) { rows.set(Number(c[0]), c); added++; }
  return { bars: added ? save(symbol, rows) : rows.size, added };
}

/**
 * Make sure every symbol has its full history on disk: backfill the ones that
 * are missing or short, extend all of them once per UTC day. Safe to call at
 * boot; it runs in the background and never throws.
 */
export async function ensureArchive(symbols: string[], opts: { minBars?: number } = {}): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const extended = kvGet<string>(KV_LAST) === today;
  for (const s of symbols) {
    try {
      const have = load(s).size;
      if (have < (opts.minBars ?? 500)) {
        const r = await backfill(s);
        console.log(`archive ${s}: backfilled to ${r.bars} bars (+${r.added})`);
      }
      if (!extended) {
        const r = await extend(s);
        if (r.added) console.log(`archive ${s}: +${r.added} → ${r.bars} bars`);
      }
      await sleep(PAUSE_MS);
    } catch (err) {
      console.error(`archive ${s}: ${err}`);
    }
  }
  kvSet(KV_LAST, today);
}
