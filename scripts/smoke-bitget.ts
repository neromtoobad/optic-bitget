// Smoke test for the computed leg of the Bitget edition — no LLM, no key.
// Resolves each ticker to its rToken perpetual and prints the numbers the desk
// will cite: price, basis to index, funding, open interest, session state.
//   npx tsx scripts/smoke-bitget.ts NVDA AAPL SPY FAKE
import { BudgetGuard } from "../src/pipeline/budget.js";
import { findBitgetFuture } from "../src/lenses/stocks.js";
import { rwaContracts } from "../src/lib/bitget/rest.js";
import { usCashSession, minutesToUsCashOpen } from "../src/lib/bitget/session.js";

const tickers = process.argv.slice(2);
const budget = new BudgetGuard();

const universe = await rwaContracts(budget);
console.log(`rToken perpetuals Bitget lists right now: ${universe.length}`);
console.log(universe.map((c) => c.baseCoin).sort().join(" "));
console.log(`US cash session: ${usCashSession()} (${minutesToUsCashOpen()} min to open)\n`);

for (const t of tickers.length ? tickers : ["NVDA", "AAPL", "SPY", "FAKE"]) {
  const leg = await findBitgetFuture(t, budget);
  console.log(`${t}:`, leg ? JSON.stringify(leg, null, 2) : "not listed as an rToken perpetual");
}
console.log(`\ncost: $${budget.total().toFixed(4)} (public data — should be $0.0000)`);
