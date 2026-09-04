import { randomUUID } from "node:crypto";
import { db } from "../db.js";

// Pick-tracking: OPTIC logs every prediction-market read it surfaces, records the
// market-favored outcome + its implied probability at that moment, and scores it
// once the market resolves on-chain. This is the HONEST version of "accuracy" —
// a real, unfakeable record, never a claimed number. We surface the market's read
// and show how those reads resolve; we never claim to beat the market.

db.exec(`
CREATE TABLE IF NOT EXISTS picks (
  id TEXT PRIMARY KEY,
  read_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  category TEXT NOT NULL,             -- prediction (only prediction picks are objectively scoreable)
  subject TEXT,                       -- what the pick is about
  market_question TEXT NOT NULL,
  market_slug TEXT NOT NULL,
  favored_outcome TEXT NOT NULL,      -- 'yes' | 'no' — the side the market favored at pick time
  implied_prob REAL NOT NULL,         -- max(yes, 1-yes) at pick time
  status TEXT NOT NULL DEFAULT 'open',-- open | correct | incorrect | void
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_picks_status ON picks(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_picks_slug_read ON picks(market_slug, read_id);
`);

const GAMMA = "https://gamma-api.polymarket.com";

export interface LoggablePick {
  category: "prediction";
  subject: string;
  market_question: string;
  market_slug: string;
  yes_price: number; // live yes-price at pick time
}

/** Log the market-favored outcome for each surfaced prediction market. */
export function logPicks(readId: string, picks: LoggablePick[]): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO picks (id, read_id, category, subject, market_question, market_slug, favored_outcome, implied_prob)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const p of picks) {
    if (!p.market_slug) continue;
    // Only track MEANINGFUL contests. A favorite above ~85% is usually a trivially-
    // correct read (e.g. "Norway won't win the World Cup" → No), which would inflate
    // the hit rate dishonestly. We track genuine calls — head-to-heads and real
    // toss-ups where surfacing the favored side is an actual pick.
    const implied = Math.max(p.yes_price, 1 - p.yes_price);
    if (implied > 0.85) continue;
    const favored = p.yes_price >= 0.5 ? "yes" : "no";
    insert.run(randomUUID(), readId, p.category, p.subject, p.market_question, p.market_slug, favored, Math.round(implied * 1000) / 1000);
  }
}

interface GammaMarket {
  closed?: boolean;
  outcomePrices?: string;
}

async function fetchMarket(slug: string): Promise<GammaMarket | null> {
  try {
    const res = await fetch(`${GAMMA}/markets?slug=${encodeURIComponent(slug)}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const raw = (await res.json()) as GammaMarket[];
    return (Array.isArray(raw) ? raw : [])[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve open picks against Polymarket. A closed market snaps outcomePrices to
 * ["1","0"] (YES won) or ["0","1"] (NO won); score the favored outcome against it.
 */
export async function resolveOpenPicks(limit = 40): Promise<{ checked: number; resolved: number }> {
  const open = db
    .prepare("SELECT id, market_slug, favored_outcome FROM picks WHERE status = 'open' ORDER BY created_at ASC LIMIT ?")
    .all(limit) as Array<{ id: string; market_slug: string; favored_outcome: string }>;

  let resolved = 0;
  const update = db.prepare("UPDATE picks SET status = ?, resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?");
  for (const p of open) {
    const m = await fetchMarket(p.market_slug);
    if (!m || !m.closed) continue;
    const prices = ((): number[] => {
      try {
        return (JSON.parse(m.outcomePrices ?? "[]") as string[]).map(Number);
      } catch {
        return [];
      }
    })();
    if (prices.length < 2) continue;
    const yesWon = prices[0] >= 0.5; // outcomes are [Yes, No]
    const winner = yesWon ? "yes" : "no";
    update.run(p.favored_outcome === winner ? "correct" : "incorrect", p.id);
    resolved++;
  }
  return { checked: open.length, resolved };
}

export interface TrackRecord {
  total: number;
  resolved: number;
  correct: number;
  open: number;
  hit_rate: number | null; // correct / resolved, null until any resolve
  avg_implied_prob: number | null; // context: were these favorites or coin-flips
  recent: Array<{ market: string; favored: string; implied_prob: number; status: string; created_at: string }>;
}

export function trackRecord(): TrackRecord {
  const agg = db
    .prepare(
      `SELECT
        COUNT(*) total,
        SUM(status IN ('correct','incorrect')) resolved,
        SUM(status = 'correct') correct,
        SUM(status = 'open') open,
        AVG(implied_prob) avg_implied
       FROM picks`
    )
    .get() as { total: number; resolved: number; correct: number; open: number; avg_implied: number | null };

  const recent = db
    .prepare(
      "SELECT market_question market, favored_outcome favored, implied_prob, status, created_at FROM picks ORDER BY created_at DESC LIMIT 15"
    )
    .all() as TrackRecord["recent"];

  const resolved = agg.resolved ?? 0;
  return {
    total: agg.total ?? 0,
    resolved,
    correct: agg.correct ?? 0,
    open: agg.open ?? 0,
    hit_rate: resolved > 0 ? Math.round((agg.correct / resolved) * 1000) / 1000 : null,
    avg_implied_prob: agg.avg_implied === null ? null : Math.round(agg.avg_implied * 1000) / 1000,
    recent,
  };
}
