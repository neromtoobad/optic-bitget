import { createHash } from "node:crypto";
import { db } from "../db.js";
import { ticker as bgTicker, num as bgNum } from "../lib/bitget/rest.js";
import type { DeskVerdict } from "./types.js";

// LEDGER — every verdict the desk issues, written before the trader sees it,
// and graded against what the perpetual actually did when the horizon
// elapses. This is the scoreboard's source of truth and the desk's own review
// loop. Rows are hash-chained: each row's hash covers its content and the
// previous row's hash, so a verdict cannot be edited after the fact without
// breaking every row that followed. `verifyChain()` recomputes it from scratch.
//
// Grading rule (deterministic, published): a directional thesis "held" when the
// perp moved in its direction between the read and resolution. Neutral theses
// are recorded but not graded. Every graded verdict gets a Brier score against
// its own P(holds) — abstentions included, at the 0.5 they imply. Brier Index
// follows ForecastBench: 100 = perfect, 50 = uninformed, 0 = maximally wrong.

db.exec(`
CREATE TABLE IF NOT EXISTS desk_ledger (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  thesis TEXT NOT NULL,
  ticker TEXT NOT NULL,
  symbol TEXT,
  direction TEXT,                 -- up | down | neutral
  horizon_hours REAL,
  resolves_at TEXT,
  call TEXT,                      -- holds | priced_in | contested | insufficient_evidence | none
  p_thesis_holds REAL,
  base_rate_p REAL,               -- the archive's Laplace hit rate for this window type
  analog_n INTEGER,
  confidence REAL,
  coverage_ratio REAL,
  debated INTEGER NOT NULL DEFAULT 0,
  entry_perp REAL,
  entry_cash REAL,
  session TEXT,
  resolved_at TEXT,
  resolved_perp REAL,
  realized_pct REAL,
  outcome INTEGER,                -- 1 held, 0 failed, NULL not graded
  brier REAL,                     -- judge's Brier (NULL when the desk issued no verdict)
  brier_base REAL,                -- base-rate forecaster's Brier over the same window
  prev_hash TEXT,
  hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS desk_ledger_due ON desk_ledger (resolved_at, resolves_at);
`);
// Columns added after the first deploy — idempotent migrations for an existing file.
for (const col of ["base_rate_p REAL", "analog_n INTEGER", "brier_base REAL"]) {
  try { db.exec(`ALTER TABLE desk_ledger ADD COLUMN ${col}`); } catch { /* already there */ }
}

export interface LedgerRow {
  id: string;
  created_at: string;
  thesis: string;
  ticker: string;
  symbol: string | null;
  direction: "up" | "down" | "neutral" | null;
  horizon_hours: number | null;
  resolves_at: string | null;
  call: string | null;
  p_thesis_holds: number | null;
  base_rate_p: number | null;
  analog_n: number | null;
  confidence: number | null;
  coverage_ratio: number | null;
  debated: number;
  entry_perp: number | null;
  entry_cash: number | null;
  session: string | null;
  resolved_at: string | null;
  resolved_perp: number | null;
  realized_pct: number | null;
  outcome: number | null;
  brier: number | null;
  brier_base: number | null;
  prev_hash: string | null;
  hash: string;
}

const HASHED_FIELDS: Array<keyof Omit<LedgerRow, "hash">> = ["id", "created_at", "thesis", "ticker", "symbol", "direction", "horizon_hours", "resolves_at", "call", "p_thesis_holds", "base_rate_p", "analog_n", "confidence", "coverage_ratio", "debated", "entry_perp", "entry_cash", "session", "prev_hash"];

function rowHash(row: Omit<LedgerRow, "hash">): string {
  const canonical = JSON.stringify(HASHED_FIELDS.map((k) => [k, row[k] ?? null]));
  return createHash("sha256").update(canonical).digest("hex");
}

function lastHash(): string | null {
  const r = db.prepare("SELECT hash FROM desk_ledger ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as { hash: string } | undefined;
  return r?.hash ?? null;
}

/** Write a verdict to the chain. Called before the verdict is returned to the trader. */
export function recordDeskRead(id: string, v: DeskVerdict): LedgerRow {
  const createdAt = v.generated_at;
  const horizon = v.read?.horizon_hours ?? null;
  const resolvesAt = horizon ? new Date(new Date(createdAt).getTime() + horizon * 3600_000).toISOString() : null;
  const row: Omit<LedgerRow, "hash"> = {
    id,
    created_at: createdAt,
    thesis: v.query,
    ticker: v.evidence.ticker,
    symbol: v.evidence.symbol,
    direction: v.read?.direction ?? null,
    horizon_hours: horizon,
    resolves_at: resolvesAt,
    call: v.judge?.call ?? "none",
    p_thesis_holds: v.judge?.p_thesis_holds ?? null,
    base_rate_p: v.evidence.analogs?.base_rate_p ?? null,
    analog_n: v.evidence.analogs?.n ?? null,
    confidence: v.judge?.confidence ?? null,
    coverage_ratio: v.evidence.coverage.ratio,
    debated: v.debated ? 1 : 0,
    entry_perp: v.evidence.perp?.price ?? null,
    entry_cash: v.evidence.cash?.price ?? null,
    session: v.evidence.gap?.session ?? null,
    resolved_at: null,
    resolved_perp: null,
    realized_pct: null,
    outcome: null,
    brier: null,
    brier_base: null,
    prev_hash: lastHash(),
  };
  const hash = rowHash(row);
  db.prepare(
    `INSERT INTO desk_ledger (id, created_at, thesis, ticker, symbol, direction, horizon_hours, resolves_at, call, p_thesis_holds, base_rate_p, analog_n, confidence, coverage_ratio, debated, entry_perp, entry_cash, session, prev_hash, hash)
     VALUES (@id, @created_at, @thesis, @ticker, @symbol, @direction, @horizon_hours, @resolves_at, @call, @p_thesis_holds, @base_rate_p, @analog_n, @confidence, @coverage_ratio, @debated, @entry_perp, @entry_cash, @session, @prev_hash, @hash)`
  ).run({ ...row, hash });
  return { ...row, hash };
}

/** ForecastBench-style index: 100 perfect, 50 uninformed (Brier 0.25), 0 maximally wrong (Brier 1). */
export function brierIndex(brier: number): number {
  const idx = brier <= 0.25 ? 100 - (brier / 0.25) * 50 : 50 - ((brier - 0.25) / 0.75) * 50;
  return Math.round(Math.max(0, Math.min(100, idx)) * 10) / 10;
}

/**
 * Grade every row whose horizon has elapsed against the perp's current price.
 * Directional theses are graded; neutral ones are marked resolved without a
 * score. Returns how many rows were graded this pass. Never throws.
 */
export async function resolveDue(nowMs = Date.now()): Promise<number> {
  const due = db.prepare("SELECT * FROM desk_ledger WHERE resolved_at IS NULL AND resolves_at IS NOT NULL AND resolves_at <= ? ORDER BY resolves_at").all(new Date(nowMs).toISOString()) as LedgerRow[];
  let graded = 0;
  for (const r of due) {
    // Nothing to grade without a perp entry, a direction, and at least one
    // forecast (the judge's P or the archive's base rate).
    if (!r.symbol || r.entry_perp === null || (r.p_thesis_holds === null && r.base_rate_p === null)) {
      db.prepare("UPDATE desk_ledger SET resolved_at = ? WHERE id = ?").run(new Date(nowMs).toISOString(), r.id);
      continue;
    }
    const tk = await bgTicker(r.symbol).catch(() => null);
    const px = bgNum(tk?.lastPr);
    if (px === null) continue; // exchange unreachable — try again next pass
    const realized = ((px - r.entry_perp) / r.entry_perp) * 100;
    let outcome: number | null = null;
    if (r.direction === "up") outcome = realized > 0 ? 1 : 0;
    else if (r.direction === "down") outcome = realized < 0 ? 1 : 0;
    // The judge's Brier (an abstention implies 0.5 and is scored at exactly
    // that) and the base rate's, over the same window — the comparison the
    // scoreboard exists to make.
    const sq = (p: number) => (outcome === null ? null : Math.round((p - outcome) ** 2 * 10000) / 10000);
    const brier = r.p_thesis_holds === null && r.call !== "insufficient_evidence" ? null : sq(r.p_thesis_holds ?? 0.5);
    const brierBase = r.base_rate_p === null ? null : sq(r.base_rate_p);
    db.prepare("UPDATE desk_ledger SET resolved_at = ?, resolved_perp = ?, realized_pct = ?, outcome = ?, brier = ?, brier_base = ? WHERE id = ?").run(
      new Date(nowMs).toISOString(),
      Math.round(px * 100) / 100,
      Math.round(realized * 1000) / 1000,
      outcome,
      brier,
      brierBase,
      r.id
    );
    if (outcome !== null) graded++;
  }
  return graded;
}

export interface Scoreboard {
  rows: LedgerRow[];
  summary: {
    reads: number;
    debated: number;
    abstained: number;
    graded: number;
    held: number;
    hit_rate: number | null;
    mean_brier: number | null;
    brier_index: number | null;
    /** The archive's base-rate forecaster over the same graded rows — what the judge has to beat. */
    base_rate: { graded: number; mean_brier: number | null; brier_index: number | null; hit_rate: number | null };
    /** Reliability buckets: what the desk said vs what happened. */
    calibration: Array<{ bucket: string; n: number; mean_p: number; hit_rate: number }>;
  };
  chain: { rows: number; valid: boolean; head: string | null };
}

export function scoreboard(limit = 200): Scoreboard {
  const rows = db.prepare("SELECT * FROM desk_ledger ORDER BY created_at DESC LIMIT ?").all(limit) as LedgerRow[];
  const all = db.prepare("SELECT * FROM desk_ledger ORDER BY created_at ASC").all() as LedgerRow[];
  const graded = all.filter((r) => r.outcome !== null && r.brier !== null);
  const held = graded.filter((r) => r.outcome === 1).length;
  const meanBrier = graded.length ? graded.reduce((s, r) => s + (r.brier ?? 0), 0) / graded.length : null;
  const gradedBase = all.filter((r) => r.outcome !== null && r.brier_base !== null);
  const meanBase = gradedBase.length ? gradedBase.reduce((s, r) => s + (r.brier_base ?? 0), 0) / gradedBase.length : null;
  const buckets = [
    [0.1, 0.3],
    [0.3, 0.5],
    [0.5, 0.7],
    [0.7, 0.9],
  ] as const;
  const calibration = buckets
    .map(([lo, hi]) => {
      const inb = graded.filter((r) => (r.p_thesis_holds ?? 0.5) >= lo && (r.p_thesis_holds ?? 0.5) < (hi === 0.9 ? 0.91 : hi));
      if (!inb.length) return null;
      return {
        bucket: `${lo.toFixed(1)}–${hi.toFixed(1)}`,
        n: inb.length,
        mean_p: Math.round((inb.reduce((s, r) => s + (r.p_thesis_holds ?? 0.5), 0) / inb.length) * 100) / 100,
        hit_rate: Math.round((inb.filter((r) => r.outcome === 1).length / inb.length) * 100) / 100,
      };
    })
    .filter((b): b is NonNullable<typeof b> => b !== null);
  return {
    rows,
    summary: {
      reads: all.length,
      debated: all.filter((r) => r.debated).length,
      abstained: all.filter((r) => r.call === "insufficient_evidence").length,
      graded: graded.length,
      held,
      hit_rate: graded.length ? Math.round((held / graded.length) * 100) / 100 : null,
      mean_brier: meanBrier === null ? null : Math.round(meanBrier * 10000) / 10000,
      brier_index: meanBrier === null ? null : brierIndex(meanBrier),
      base_rate: {
        graded: gradedBase.length,
        mean_brier: meanBase === null ? null : Math.round(meanBase * 10000) / 10000,
        brier_index: meanBase === null ? null : brierIndex(meanBase),
        hit_rate: gradedBase.length ? Math.round((gradedBase.filter((r) => r.outcome === 1).length / gradedBase.length) * 100) / 100 : null,
      },
      calibration,
    },
    chain: verifyChain(all),
  };
}

/** Recompute every hash from genesis; any edited row breaks the chain from that point on. */
export function verifyChain(rows?: LedgerRow[]): { rows: number; valid: boolean; head: string | null } {
  const all = rows ?? (db.prepare("SELECT * FROM desk_ledger ORDER BY created_at ASC, rowid ASC").all() as LedgerRow[]);
  let prev: string | null = null;
  for (const r of all) {
    if (r.prev_hash !== prev) return { rows: all.length, valid: false, head: r.hash };
    const { hash, ...rest } = r;
    if (rowHash(rest) !== hash) return { rows: all.length, valid: false, head: hash };
    prev = hash;
  }
  return { rows: all.length, valid: true, head: prev };
}
