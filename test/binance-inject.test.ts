import { test } from "node:test";
import assert from "node:assert/strict";
import { exchangeFromMcpPayload } from "../src/lib/binance/inject.js";
import { lintVerdictStrings } from "../src/lint.js";

// The caller's agent pastes whatever its Binance MCP tools returned. Shapes vary
// by tool and client, so the parser must find fields by name through arrays,
// wrappers and JSON strings — and refuse a payload it cannot actually read.

test("reads a plain 24h ticker object", () => {
  const v = exchangeFromMcpPayload({
    symbol: "BTCUSDT",
    lastPrice: "77857.49",
    priceChangePercent: "0.482",
    quoteVolume: "1002472901.9",
    highPrice: "77900.00",
    lowPrice: "76264.00",
  });
  assert.ok(v);
  assert.equal(v.symbol, "BTCUSDT");
  assert.equal(v.source, "binance-mcp");
  assert.equal(v.spot?.price, 77857.49);
  assert.equal(v.spot?.chg_24h, 0.48);
  assert.equal(v.perps, null);
  assert.match(v.read, /BTCUSDT \$77,857/);
});

test("merges several tool results and derives funding + open interest", () => {
  const v = exchangeFromMcpPayload([
    { symbol: "BTCUSDT", lastPrice: "77857.49", priceChangePercent: "0.482", quoteVolume: "1002472901" },
    { symbol: "BTCUSDT", markPrice: "77835.75", lastFundingRate: "0.0000803", nextFundingTime: 1788422400000 },
    { symbol: "BTCUSDT", openInterest: "107785.834" },
    { symbol: "BTCUSDT", longAccount: "0.5488", longShortRatio: "1.2163" },
  ]);
  assert.ok(v?.perps);
  assert.equal(v.perps.funding_rate, 0.0000803);
  assert.equal(v.perps.funding_annualized_pct, 8.8);
  assert.equal(v.perps.accounts_up_pct, 54.9);
  assert.equal(v.perps.accounts_up_down_ratio, 1.22);
  assert.equal(v.perps.next_funding_at, "2026-09-03T08:00:00.000Z");
  // open interest in USD is derived from mark price when the tool didn't report it
  assert.equal(v.perps.open_interest, 107785.834);
  assert.equal(v.perps.open_interest_usd, 107785.834 * 77835.75);
  assert.equal(v.basis_pct, -0.028);
});

test("unwraps an MCP tool result envelope and a JSON string body", () => {
  const v = exchangeFromMcpPayload({
    content: [{ type: "text", text: JSON.stringify({ symbol: "ETHUSDT", price: "2404.93", priceChangePercent: "-1.2" }) }],
  });
  assert.equal(v?.symbol, "ETHUSDT");
  assert.equal(v?.spot?.price, 2404.93);
  assert.equal(v?.spot?.chg_24h, -1.2);
});

test("falls back to the caller's symbol when the payload omits one", () => {
  const v = exchangeFromMcpPayload({ lastPrice: "1.84" }, "CAKEUSDT");
  assert.equal(v?.symbol, "CAKEUSDT");
  assert.equal(v?.spot?.price, 1.84);
});

test("refuses a payload with no price rather than half-reading it", () => {
  assert.equal(exchangeFromMcpPayload({ symbol: "BTCUSDT", note: "rate limited" }), null);
  assert.equal(exchangeFromMcpPayload("not json at all"), null);
  assert.equal(exchangeFromMcpPayload(null), null);
  assert.equal(exchangeFromMcpPayload({ lastPrice: "77857" }), null); // no symbol anywhere
});

test("the injected read line still passes the language lint", () => {
  const v = exchangeFromMcpPayload([
    { symbol: "BTCUSDT", lastPrice: "77857.49", priceChangePercent: "0.482", quoteVolume: "1002472901" },
    { symbol: "BTCUSDT", markPrice: "77835.75", lastFundingRate: "-0.0001", openInterest: "107785" },
    { symbol: "BTCUSDT", longAccount: "0.62", buySellRatio: "1.59" },
  ]);
  assert.ok(v);
  assert.equal(lintVerdictStrings([v.read]).ok, true);
});
