import { test } from "node:test";
import assert from "node:assert/strict";
import { computeWellness, safeTimezone } from "../src/engine/wellness.js";
import type { WalletTx } from "../src/lenses/wallet.js";

const now = Math.floor(Date.now() / 1000);
const DAY = 86_400;
const HOUR = 3_600;

/** Build a tx at `daysAgo` days back, at a given UTC hour. */
function at(daysAgo: number, utcHour: number, minute = 0): WalletTx {
  const d = new Date((now - daysAgo * DAY) * 1000);
  d.setUTCHours(utcHour, minute, 0, 0);
  return { ts: Math.floor(d.getTime() / 1000), chain: "ethereum" };
}

test("dormant wallet scores high with honest positives", () => {
  const w = computeWellness([at(80, 12), at(60, 12)], "UTC");
  assert.equal(w.score, 92);
  assert.equal(w.patterns.length, 0);
  assert.ok(w.positives[0].includes("2 transactions"));
});

test("night owl pattern detected and scored", () => {
  // 40 txs, half at 3am UTC, spread across distinct days, on separate days →
  // night_pct 50% (severe). Spread avoids sessions/bursts contaminating the test.
  const txs: WalletTx[] = [];
  for (let i = 0; i < 20; i++) txs.push(at(i * 3 + 2, 3));
  for (let i = 0; i < 20; i++) txs.push(at(i * 3 + 1, 14));
  const w = computeWellness(txs, "UTC");
  const night = w.patterns.find((p) => p.id === "late_night");
  assert.ok(night, "expected late_night pattern");
  assert.equal(night.severity, "severe");
  assert.ok(w.score < 92);
});

test("timezone shifts night classification", () => {
  // 3am UTC is noon-ish in Tokyo (+9 → 12:00): the same wallet reads clean there.
  const txs: WalletTx[] = [];
  for (let i = 0; i < 20; i++) txs.push(at(i * 4 + 2, 3));
  const utc = computeWellness(txs, "UTC");
  const tokyo = computeWellness(txs, "Asia/Tokyo");
  assert.ok(utc.patterns.some((p) => p.id === "late_night"));
  assert.ok(!tokyo.patterns.some((p) => p.id === "late_night"));
});

test("burst sessions detected", () => {
  // 6 txs inside 10 minutes, repeated weekly → rapid-fire pattern.
  const txs: WalletTx[] = [];
  for (let week = 0; week < 12; week++) {
    const base = now - week * 7 * DAY - 5 * HOUR;
    for (let i = 0; i < 6; i++) txs.push({ ts: base + i * 90, chain: "base" });
  }
  const w = computeWellness(txs, "UTC");
  const burst = w.patterns.find((p) => p.id === "burst_sessions");
  assert.ok(burst, "expected burst_sessions pattern");
  assert.ok(w.stats.burst_count >= 10);
});

test("grass drought: no 24h break in 90 days", () => {
  // Two txs every day, 12h apart → longest gap is 12h.
  const txs: WalletTx[] = [];
  for (let d = 0; d < 90; d++) {
    txs.push(at(d, 9));
    txs.push(at(d, 21));
  }
  const w = computeWellness(txs, "UTC");
  const drought = w.patterns.find((p) => p.id === "grass_drought");
  assert.ok(drought, "expected grass_drought pattern");
  assert.equal(drought.severity, "severe");
  const alwaysOn = w.patterns.find((p) => p.id === "always_on");
  assert.ok(alwaysOn, "expected always_on pattern");
  assert.equal(alwaysOn.severity, "severe");
});

test("quiet tail counts as a break", () => {
  // Daily grind that stopped 10 days ago → longest break ≥ 240h, no drought.
  const txs: WalletTx[] = [];
  for (let d = 10; d < 60; d++) txs.push(at(d, 12));
  const w = computeWellness(txs, "UTC");
  // ~10 days of silence (±1 day of wall-clock offset from the fixture's fixed noon)
  assert.ok(w.stats.longest_break_h >= 216, `tail break ${w.stats.longest_break_h}h`);
  assert.ok(!w.patterns.some((p) => p.id === "grass_drought"));
});

test("score is bounded and persona matches band", () => {
  // Worst-case wallet: nightly 3am (UTC, fixed) bursts, every day, weekends included.
  const txs: WalletTx[] = [];
  for (let d = 1; d < 90; d++) {
    for (let i = 0; i < 6; i++) txs.push(at(d, 3, i));
    txs.push(at(d, 15));
  }
  const w = computeWellness(txs, "UTC");
  assert.ok(w.score >= 3 && w.score <= 100);
  assert.ok(w.score < 45, `expected goblin-or-worse, got ${w.score}`);
  assert.ok(["Chart Goblin", "Vitamin D Deficient", "Grass Emergency"].includes(w.persona));
});

test("gym window is a weekday block", () => {
  const txs: WalletTx[] = [];
  for (let d = 0; d < 30; d++) txs.push(at(d, 12));
  const w = computeWellness(txs, "UTC");
  assert.match(w.gym_window ?? "", /^(Mon|Tue|Wed|Thu|Fri) \d{2}:00–\d{2}:00$/);
});

test("safeTimezone falls back to UTC on garbage", () => {
  assert.equal(safeTimezone("Not/AZone"), "UTC");
  assert.equal(safeTimezone(undefined), "UTC");
  assert.equal(safeTimezone("Africa/Lagos"), "Africa/Lagos");
});
