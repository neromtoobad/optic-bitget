import { test } from "node:test";
import assert from "node:assert/strict";
import { composeRead } from "../src/lenses/binance/cex.js";
import { lintVerdictStrings } from "../src/lint.js";

// The exchange read is fed to the gap engine and can be echoed into user-facing
// strings, so it must never carry a banned word (buy/sell/long/short…).
test("binance venue read line passes the language lint", () => {
  const read = composeRead(
    "BTCUSDT",
    { price: 77857.49, chg_24h: 0.48, volume_24h_usd: 1_002_472_901, high_24h: 77900, low_24h: 76264 },
    {
      mark_price: 77835.75,
      funding_rate: 0.0000803,
      funding_annualized_pct: 8.8,
      next_funding_at: "2026-09-03T08:00:00.000Z",
      open_interest: 107785.8,
      open_interest_usd: 8_389_591_687,
      open_interest_chg_24h: -0.9,
      accounts_up_pct: 54.9,
      accounts_up_down_ratio: 1.22,
      taker_flow_ratio: 1.59,
    },
    -0.028
  );
  assert.match(read, /BTCUSDT \$77,857/);
  assert.match(read, /funding \+0\.0080%\/8h/);
  assert.match(read, /open interest \$8\.39B/);
  const lint = lintVerdictStrings([read]);
  assert.equal(lint.ok, true, JSON.stringify(lint.violations));
});

test("binance venue read line handles a spot-only listing", () => {
  const read = composeRead("CAKEUSDT", { price: 1.84, chg_24h: 0.59, volume_24h_usd: 2_891_324, high_24h: 1.85, low_24h: 1.78 }, null, null);
  assert.equal(read, "CAKEUSDT $1.84 (+0.59% 24h, $2.9M volume) on Binance spot");
});
