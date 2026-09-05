import type { Lens, MemeVenue, Resolved } from "../types.js";
import { BudgetGuard } from "../pipeline/budget.js";
import { isCliEntry } from "../fixtures.js";
import { onchainBinance } from "./binance/onchain.js";

// ONCHAIN lens — what the token itself is doing on Binance Web3: price,
// liquidity, holders, dev/bundler composition and comparable tokens.
export const memeLens: Lens<MemeVenue> = {
  name: "meme",
  read: (resolved: Resolved, budget: BudgetGuard) => onchainBinance(resolved, budget),
};

if (isCliEntry(import.meta.url)) {
  const budget = new BudgetGuard();
  const name = process.argv.slice(2).join(" ") || "BTC";
  console.log(JSON.stringify(await memeLens.read({ type: "token", name }, budget), null, 2));
  console.log(`cost: $${budget.total().toFixed(5)}`);
}
