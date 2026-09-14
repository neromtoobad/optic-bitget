import { test } from "node:test";
import assert from "node:assert/strict";
import { usCashSession, usCashSessionOpen, minutesToUsCashOpen } from "../src/lib/bitget/session.js";
import { parseCandle } from "../src/lib/bitget/rest.js";
import { strikeCitations } from "../src/desk/debate.js";
import { classifySignal } from "../src/desk/evidence.js";
import { brierIndex } from "../src/desk/ledger.js";
import type { EvidenceTable } from "../src/desk/types.js";

// ── the clock is computed, never argued ──────────────────────────────

test("US cash session: a Monday at 10:00 ET is open", () => {
  // 2026-09-14 is a Monday; 14:00Z = 10:00 EDT
  assert.equal(usCashSession(new Date("2026-09-14T14:00:00Z")), "open");
  assert.equal(usCashSessionOpen(new Date("2026-09-14T14:00:00Z")), true);
});

test("US cash session: 09:29 ET is closed, 09:30 ET is open, 16:00 ET is closed", () => {
  assert.equal(usCashSession(new Date("2026-09-14T13:29:00Z")), "closed");
  assert.equal(usCashSession(new Date("2026-09-14T13:30:00Z")), "open");
  assert.equal(usCashSession(new Date("2026-09-14T20:00:00Z")), "closed");
});

test("US cash session: Saturday is the weekend, and minutes-to-open skips it", () => {
  const sat = new Date("2026-09-12T15:00:00Z"); // Saturday 11:00 EDT
  assert.equal(usCashSession(sat), "weekend");
  // Monday 09:30 EDT = 2026-09-14T13:30Z → 46.5 hours later
  assert.equal(minutesToUsCashOpen(sat), 46.5 * 60);
});

test("US cash session: while open, minutes-to-open is zero", () => {
  assert.equal(minutesToUsCashOpen(new Date("2026-09-14T15:00:00Z")), 0);
});

// ── candles ──────────────────────────────────────────────────────────

test("parseCandle turns Bitget's string tuple into numbers and rejects garbage", () => {
  const bar = parseCandle(["1789398000000", "210.74", "212.51", "210.58", "212.37", "4196.87", "888092.2672"]);
  assert.deepEqual(bar, { ts: 1789398000000, open: 210.74, high: 212.51, low: 210.58, close: 212.37, volume: 4196.87, quoteVolume: 888092.2672 });
  assert.equal(parseCandle(["x", "1", "2", "3", "4", "5", "6"]), null);
});

// ── the citation rule ────────────────────────────────────────────────

function table(rows: Array<[string, "ok" | "empty" | "error"]>): EvidenceTable {
  return {
    thesis: "t",
    ticker: "NVDA",
    company: "NVIDIA",
    symbol: "NVDAUSDT",
    rows: rows.map(([id, status]) => ({ id, source: "test", label: id, computed: true, status, fetched_at: "now", value: status === "ok" ? {} : null })),
    coverage: { total: rows.length, ok: 0, empty: 0, error: 0, skipped: 0, computed_ok: 0, ratio: 0 },
    gap: null,
    gathered_at: "now",
    perp: null,
    cash: null,
    prediction: null,
  };
}

test("citations to ok rows are kept; unknown ids and non-ok rows are struck", () => {
  const ev = table([
    ["perp", "ok"],
    ["gap", "ok"],
    ["news", "error"],
    ["prediction", "empty"],
  ]);
  const { kept, struck } = strikeCitations(["perp", "[gap]", "news", "prediction", "made_up", "perp"], ev);
  assert.deepEqual(kept, ["perp", "gap"]);
  assert.deepEqual(struck, ["news", "prediction", "made_up"]);
});

// ── an upstream failure inside a 200 is still a failure ──────────────

test("classifySignal reads bitget-signal's blank-error shapes as errors, not data", () => {
  assert.equal(classifySignal({ error: "" }).status, "error");
  assert.equal(classifySignal({ alt_me_error: "" }).status, "error");
  assert.equal(classifySignal([{ feed: "cnbc", error: "", items: [] }, { feed: "fed", error: "", items: [] }]).status, "error");
  assert.equal(classifySignal(null).status, "error");
  // rates_yields with FRED down: a full-shaped object whose every field is an error
  assert.equal(classifySignal({ t2y: { error: "" }, t10y: { error: "" }, sofr: { error: "" } }).status, "error");
  assert.equal(classifySignal([]).status, "empty");
  assert.equal(classifySignal({}).status, "empty");
});

test("classifySignal accepts real payloads", () => {
  assert.equal(classifySignal({ symbol: "NVDAUSDT", rsi: { rsi: 41.13 }, verdict: "BEARISH" }).status, "ok");
  assert.equal(classifySignal([{ timestamp: 1, open: 1, close: 2 }]).status, "ok");
  assert.equal(classifySignal("some text").status, "ok");
});

// ── scoring ──────────────────────────────────────────────────────────

test("brierIndex follows ForecastBench: 100 perfect, 50 uninformed, 0 maximally wrong", () => {
  assert.equal(brierIndex(0), 100);
  assert.equal(brierIndex(0.25), 50);
  assert.equal(brierIndex(1), 0);
  assert.equal(brierIndex(0.125), 75);
  assert.equal(brierIndex(0.625), 25);
});
