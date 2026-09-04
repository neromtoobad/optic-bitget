import type { Resolved } from "../../types.js";
import type { SmartMoneyToken } from "../smartmoney.js";
import { smartMoneySignals, smartMoneyInflow, toBnChain, num, type SmartSignal } from "../../lib/binance/web3.js";
import type { BudgetGuard } from "../../pipeline/budget.js";

// SMART MONEY (Binance edition) — Binance Web3's tracked smart-money wallets:
// the per-trade signal feed (trading-signal skill) and the net-inflow rank
// (crypto-market-rank skill). Factual flow: who is accumulating what, never a
// trade instruction. BSC + Solana carry signals; the inflow rank adds Base.

function aggregate(feed: SmartSignal[]): SmartMoneyToken[] {
  const byToken = new Map<string, SmartMoneyToken>();
  for (const s of feed) {
    if (s.direction !== "buy" || !s.contractAddress) continue;
    const cur =
      byToken.get(s.contractAddress) ??
      ({
        symbol: s.ticker ?? "?",
        address: s.contractAddress,
        buy_usd: 0,
        signals: 0,
        wallets: 0,
        market_cap_usd: num(s.currentMarketCap),
        top10_holder_pct: null,
      } satisfies SmartMoneyToken);
    cur.buy_usd += num(s.totalTokenValue) ?? 0;
    cur.signals += s.signalCount ?? 1;
    cur.wallets += s.smartMoneyCount ?? 0;
    byToken.set(s.contractAddress, cur);
  }
  return [...byToken.values()];
}

/** Top tokens smart money is accumulating right now on a chain (default BSC). */
export async function smartMoneyFlowBinance(chain: string, budget: BudgetGuard): Promise<SmartMoneyToken[] | null> {
  const c = toBnChain(chain) ?? "56";
  const [feed, inflow] = await Promise.all([c === "56" || c === "CT_501" ? smartMoneySignals(c, 50, budget) : Promise.resolve(null), smartMoneyInflow(c, 20, budget)]);
  const fromSignals = aggregate(feed ?? []);
  const fromInflow: SmartMoneyToken[] = (inflow ?? []).map((t) => ({
    symbol: t.tokenName,
    address: t.ca,
    buy_usd: t.inflow ?? 0,
    signals: 0,
    wallets: t.traders ?? 0,
    market_cap_usd: num(t.marketCap),
    top10_holder_pct: num(t.holdersTop10Percent),
  }));
  // Merge on address: signal wallets + inflow dollars, whichever is larger per field.
  const merged = new Map<string, SmartMoneyToken>();
  for (const t of [...fromInflow, ...fromSignals]) {
    const k = t.address.toLowerCase();
    const cur = merged.get(k);
    if (!cur) merged.set(k, { ...t });
    else {
      cur.buy_usd = Math.max(cur.buy_usd, t.buy_usd);
      cur.signals += t.signals;
      cur.wallets = Math.max(cur.wallets, t.wallets);
      cur.market_cap_usd = cur.market_cap_usd ?? t.market_cap_usd;
      cur.top10_holder_pct = cur.top10_holder_pct ?? t.top10_holder_pct;
    }
  }
  const out = [...merged.values()].filter((t) => t.buy_usd > 0 || t.wallets > 0).sort((a, b) => b.wallets - a.wallets || b.buy_usd - a.buy_usd).slice(0, 8);
  return out.length > 0 ? out : null;
}

/** Is THIS token showing up in smart-money flow? */
export async function smartMoneyForTokenBinance(resolved: Resolved, budget: BudgetGuard): Promise<SmartMoneyToken | null> {
  if (resolved.type !== "token" || !resolved.address || !resolved.chain) return null;
  const c = toBnChain(resolved.chain);
  if (!c || c === "1") return null;
  const all = await smartMoneyFlowBinance(c, budget);
  return all?.find((t) => t.address.toLowerCase() === resolved.address!.toLowerCase()) ?? null;
}
