import type { Resolved } from "../types.js";
import { smartMoneySignals, num, type SignalTx } from "../lib/okx.js";
import { BudgetGuard } from "../pipeline/budget.js";
import { isCliEntry } from "../fixtures.js";
import { config } from "../config.js";
import { smartMoneyFlowCEX, smartMoneyForTokenCEX } from "./cex/smartmoney.js";

// SMART MONEY TRACKER — what sharp onchain wallets are trading right now, from
// OKX's smart-money signal feed. Following smart money is the realest edge in
// crypto. Factual flow data (who's accumulating), never a trade instruction.

export interface SmartMoneyToken {
  symbol: string;
  address: string;
  buy_usd: number; // total smart-money buy volume in the feed window
  signals: number; // number of buy signals
  wallets: number; // total smart wallets behind the signals
  market_cap_usd: number | null;
  top10_holder_pct: number | null;
}

function aggregate(feed: SignalTx[]): SmartMoneyToken[] {
  const byToken = new Map<string, SmartMoneyToken>();
  for (const tx of feed) {
    const addr = tx.token?.tokenAddress;
    if (!addr) continue;
    const cur =
      byToken.get(addr) ??
      ({
        symbol: tx.token?.symbol ?? "?",
        address: addr,
        buy_usd: 0,
        signals: 0,
        wallets: 0,
        market_cap_usd: num(tx.token?.marketCapUsd),
        top10_holder_pct: num(tx.token?.top10HolderPercent),
      } satisfies SmartMoneyToken);
    cur.buy_usd += num(tx.amountUsd) ?? 0;
    cur.signals += 1;
    cur.wallets += num(tx.triggerWalletCount) ?? 0;
    byToken.set(addr, cur);
  }
  return [...byToken.values()];
}

/** Top tokens smart money is accumulating right now (for smartmoney/daily). */
export async function smartMoneyFlow(chain: string, budget: BudgetGuard): Promise<SmartMoneyToken[] | null> {
  if (config.exchange === "cex") return smartMoneyFlowCEX(chain, budget);
  const feed = await smartMoneySignals(chain, budget);
  if (!feed || feed.length === 0) return null;
  // Rank by conviction: total smart wallets behind the token, then buy volume.
  const agg = aggregate(feed)
    .sort((a, b) => b.wallets - a.wallets || b.buy_usd - a.buy_usd)
    .slice(0, 8);
  return agg.length > 0 ? agg : null;
}

/** Is THIS specific token showing up in smart-money flow? (for token reads) */
export async function smartMoneyForToken(resolved: Resolved, budget: BudgetGuard): Promise<SmartMoneyToken | null> {
  if (config.exchange === "cex") return smartMoneyForTokenCEX(resolved, budget);
  if (resolved.type !== "token" || !resolved.address || !resolved.chain) return null;
  const feed = await smartMoneySignals(resolved.chain, budget);
  if (!feed) return null;
  const match = aggregate(feed).find((t) => t.address.toLowerCase() === resolved.address!.toLowerCase());
  return match ?? null;
}

if (isCliEntry(import.meta.url)) {
  const budget = new BudgetGuard();
  const out = await smartMoneyFlow(process.argv[2] ?? "501", budget);
  console.log(JSON.stringify(out, null, 2));
  console.log(`cost: $${budget.total().toFixed(5)}`);
}
