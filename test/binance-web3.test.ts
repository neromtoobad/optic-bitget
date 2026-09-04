import { test } from "node:test";
import assert from "node:assert/strict";
import { toBnChain, pct, pmYesOutcome, pmUrl } from "../src/lib/binance/web3.js";

test("chain ids normalise to Binance's spelling", () => {
  assert.equal(toBnChain("501"), "CT_501");
  assert.equal(toBnChain("solana"), "CT_501");
  assert.equal(toBnChain("56"), "56");
  assert.equal(toBnChain("bsc"), "56");
  assert.equal(toBnChain("8453"), "8453");
  assert.equal(toBnChain("ethereum"), "1");
  assert.equal(toBnChain("196"), null); // X Layer is not a Binance Web3 chain
});

test("percent fields normalise fractions and percents alike", () => {
  assert.equal(pct("0.024404"), 2.4);
  assert.equal(pct("38.717"), 38.7);
  assert.equal(pct(null), null);
});

test("yes outcome prefers Yes/Up, else the first outcome", () => {
  const m = { marketId: 1, title: "x", outcomes: [{ name: "No", price: 0.4 }, { name: "Yes", price: 0.6 }] };
  assert.equal(pmYesOutcome(m)?.name, "Yes");
  const up = { marketId: 2, title: "x", outcomes: [{ name: "Down", price: 0.45 }, { name: "Up", price: 0.55 }] };
  assert.equal(pmYesOutcome(up)?.name, "Up");
  const entrant = { marketId: 3, title: "x", outcomes: [{ name: "Arbitrum", price: 0.03 }] };
  assert.equal(pmYesOutcome(entrant)?.name, "Arbitrum");
  assert.equal(pmYesOutcome({ marketId: 4, title: "x", outcomes: [] }), null);
});

test("market url follows the Binance Wallet share link shape", () => {
  assert.equal(pmUrl("fed-decision-in-september-762"), "https://web3.binance.com/prediction/detail/fed-decision-in-september-762");
  assert.equal(pmUrl("laliga-2027-champion", true), "https://web3.binance.com/prediction/detail/laliga-2027-champion?topicType=grouped");
});
