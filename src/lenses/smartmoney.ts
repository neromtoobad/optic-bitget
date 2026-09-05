import type { Resolved } from "../types.js";
import { BudgetGuard } from "../pipeline/budget.js";
import { isCliEntry } from "../fixtures.js";
import { smartMoneyFlowCEX, smartMoneyForTokenCEX } from "./cex/smartmoney.js";

// SMART MONEY TRACKER — what sharp onchain wallets are trading right now, from
// CEX's tracked smart-money feed. Factual flow data (who's accumulating),
// never a trade instruction.

export interface SmartMoneyToken {
  symbol: string;
  address: string;
  buy_usd: number; // total smart-money buy volume in the feed window
  signals: number; // number of buy signals
  wallets: number; // total smart wallets behind the signals
  market_cap_usd: number | null;
  top10_holder_pct: number | null;
}

export async function smartMoneyFlow(chain: string, budget: BudgetGuard): Promise<SmartMoneyToken[] | null> {
  return smartMoneyFlowCEX(chain, budget);
}

export async function smartMoneyForToken(resolved: Resolved, budget: BudgetGuard): Promise<SmartMoneyToken | null> {
  return smartMoneyForTokenCEX(resolved, budget);
}

if (isCliEntry(import.meta.url)) {
  const budget = new BudgetGuard();
  console.log(JSON.stringify(await smartMoneyFlow("56", budget), null, 2));
  console.log(`cost: $${budget.total().toFixed(5)}`);
}
