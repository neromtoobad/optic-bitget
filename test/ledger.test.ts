import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { db } from "../src/db.js";
import { recordDeskRead, verifyChain, scoreboard } from "../src/desk/ledger.js";
import type { DeskVerdict } from "../src/desk/types.js";

// Runs against DATABASE_PATH=./data/test.db (see package.json). Rows are
// written with a unique thesis marker so the assertions target only this run.

function verdict(thesis: string, p: number | null, base: number | null): DeskVerdict {
  return {
    query: thesis,
    resolved: { type: "desk", name: "NVDA" },
    evidence: {
      thesis,
      ticker: "NVDA",
      company: "NVIDIA",
      symbol: "NVDAUSDT",
      rows: [],
      coverage: { total: 1, ok: 1, empty: 0, error: 0, skipped: 0, computed_ok: 1, ratio: 1 },
      gap: { session: "closed", minutes_to_us_open: 60, perp_price: 200, cash_price: 199, cash_previous_close: 198, perp_vs_cash_pct: 0.5, basis_pct: 0.1, funding_rate: 0.0001, funding_annualized_pct: 10, open_interest_usdt: 1, volume_24h_usdt: 1, spread_bps: 1 },
      analogs: base === null ? null : ({ base_rate_p: base, n: 40 } as unknown as DeskVerdict["evidence"]["analogs"]),
      gathered_at: new Date().toISOString(),
      perp: { symbol: "NVDAUSDT", venue: "perpetual", chain: "bitget-futures", address: "", price: 200, chg_24h: 0, liquidity: null, holders: null },
      cash: null,
      prediction: null,
    },
    transcript: [],
    debated: p !== null,
    judge: p === null ? null : { call: "holds", p_thesis_holds: p, confidence: 0.6, what_is_priced_in: "", strongest_attack: "", reasoning: "", citations: [], struck: [], samples: 3 },
    replay: null,
    clarifying_question: null,
    read: { direction: "up", horizon_hours: 16 },
    verdict_line: "test",
    llm_role: "test",
    generated_at: new Date().toISOString(),
    card_url: null,
  };
}

test("ledger: rows chain, verify, and a tampered row is caught", () => {
  const marker = `ledger-test-${randomUUID()}`;
  const a = recordDeskRead(randomUUID(), verdict(`${marker} A`, 0.7, 0.55));
  const b = recordDeskRead(randomUUID(), verdict(`${marker} B`, null, 0.48));
  assert.equal(b.prev_hash, a.hash, "each row binds the previous hash");
  assert.equal(b.hash_version, 2);
  assert.equal(verifyChain().valid, true, "chain verifies after writes");

  // Edit a forecast after the fact — the very thing the chain exists to expose.
  db.prepare("UPDATE desk_ledger SET p_thesis_holds = 0.9 WHERE id = ?").run(a.id);
  assert.equal(verifyChain().valid, false, "an edited row breaks verification");
  db.prepare("UPDATE desk_ledger SET p_thesis_holds = 0.7 WHERE id = ?").run(a.id);
  assert.equal(verifyChain().valid, true, "restoring the value restores the chain");

  const board = scoreboard(1000);
  assert.ok(board.summary.reads >= 2);
  assert.ok(board.rows.some((r) => r.thesis === `${marker} B` && r.base_rate_p === 0.48 && r.p_thesis_holds === null), "a base-rate-only read is on the board with no judge P");
});

test("ledger: a v1 row (pre-base-rate hash) still verifies alongside v2 rows", () => {
  // Emulate a row written before the base-rate columns existed: hashed with the v1 field set.
  const id = randomUUID();
  const prev = (db.prepare("SELECT hash FROM desk_ledger ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as { hash: string } | undefined)?.hash ?? null;
  const row = { id, created_at: new Date().toISOString(), thesis: "legacy", ticker: "NVDA", symbol: "NVDAUSDT", direction: "up", horizon_hours: 16, resolves_at: null, call: "none", p_thesis_holds: null, confidence: null, coverage_ratio: 0.5, debated: 0, entry_perp: 200, entry_cash: null, session: "closed", prev_hash: prev };
  const v1Fields = ["id", "created_at", "thesis", "ticker", "symbol", "direction", "horizon_hours", "resolves_at", "call", "p_thesis_holds", "confidence", "coverage_ratio", "debated", "entry_perp", "entry_cash", "session", "prev_hash"] as const;
  const hash = createHash("sha256").update(JSON.stringify(v1Fields.map((k) => [k, (row as Record<string, unknown>)[k] ?? null]))).digest("hex");
  db.prepare(`INSERT INTO desk_ledger (id, created_at, thesis, ticker, symbol, direction, horizon_hours, resolves_at, call, p_thesis_holds, confidence, coverage_ratio, debated, entry_perp, entry_cash, session, prev_hash, hash_version, hash)
              VALUES (@id, @created_at, @thesis, @ticker, @symbol, @direction, @horizon_hours, @resolves_at, @call, @p_thesis_holds, @confidence, @coverage_ratio, @debated, @entry_perp, @entry_cash, @session, @prev_hash, 1, @hash)`).run({ ...row, hash });
  assert.equal(verifyChain().valid, true, "v1 and v2 rows verify in one chain");
  recordDeskRead(randomUUID(), verdict("after legacy", 0.5, 0.5));
  assert.equal(verifyChain().valid, true, "a v2 row appended after a v1 row keeps the chain valid");
});
