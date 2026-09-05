import { test } from "node:test";
import assert from "node:assert/strict";
import { findBannedWord, lintVerdictStrings, verdictStrings } from "../src/lint.js";
import { readFileSync } from "node:fs";

test("banned words are caught", () => {
  assert.equal(findBannedWord("time to buy this"), "buy");
  assert.equal(findBannedWord("SELL now"), "sell");
  assert.equal(findBannedWord("go Long here"), "long");
  assert.equal(findBannedWord("ape in"), "ape");
});

test("banned words only match whole words", () => {
  assert.equal(findBannedWord("the market is buying time"), null); // 'buying' ≠ 'buy'
  assert.equal(findBannedWord("longer-term attention decay"), null);
  assert.equal(findBannedWord("selloff in shape only"), null);
});

test("observational language passes", () => {
  const ok = lintVerdictStrings([
    "Attention is diverging from what the meme venue prices.",
    "This story is priced-in at the prediction venue but the crowd is asleep.",
    "Crowded narrative, lagging capital.",
  ]);
  assert.equal(ok.ok, true);
});

test("mock verdict fixture passes the lint", () => {
  const verdict = JSON.parse(readFileSync("./fixtures/verdict.json", "utf8"));
  const result = lintVerdictStrings(verdictStrings(verdict));
  assert.deepEqual(result.violations, []);
  assert.equal(result.ok, true);
});

// Regression: a live optic_stocks read shipped the verdict line "Sell-side
// research sits above every reported price mark…". A hyphen is a word boundary,
// so the lint always caught it — the stocks lens simply never called the lint.
test("catches a banned word used as a hyphenated compound", () => {
  assert.equal(findBannedWord("Sell-side research sits above every reported price mark."), "sell");
  assert.equal(findBannedWord("The long-dated contract is quiet."), "long");
  // …while ordinary words that merely contain one stay clean.
  assert.equal(findBannedWord("Shortfall in liquidity across the buyer base."), null);
});
