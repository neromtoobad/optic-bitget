import type { MemeVenue, Resolved } from "../../types.js";
import { tokenDynamic, tokenSearch, toBnChain, num, pct, CHAIN_NAME } from "../../lib/binance/web3.js";
import type { BudgetGuard } from "../../pipeline/budget.js";

// ONCHAIN lens (Binance edition) — what the token is doing on its own chain,
// from Binance Web3's token market data: price/liquidity/holders, holder
// composition (dev / snipers / bundlers / insiders / smart money / KOLs), and the
// Binance-user cohort (bn* fields). Same MemeVenue shape as the OKX Trenches lens.

export async function onchainBinance(resolved: Resolved, budget: BudgetGuard): Promise<MemeVenue | null> {
  if (resolved.type !== "token" || !resolved.address || !resolved.chain) return null;
  const chain = toBnChain(resolved.chain) ?? resolved.chain;
  const [dyn, hits] = await Promise.all([tokenDynamic(chain, resolved.address, budget), tokenSearch(resolved.name, undefined, budget)]);
  if (!dyn) return null;

  const vol24 = num(dyn.volume24h);
  const buy24 = num(dyn.volume24hBuy);
  const vol1h = num(dyn.volume1h);
  return {
    price: num(dyn.price),
    chg_24h: num(dyn.percentChange24h),
    liquidity: num(dyn.liquidity),
    holders: num(dyn.holders),
    dev_flags: {
      chain: CHAIN_NAME[chain] ?? chain,
      dev_holdings_pct: pct(dyn.devHoldingPercent ?? dyn.holdersDevPercent),
      top10_pct: num(dyn.top10HoldersPercentage),
      insiders_pct: pct(dyn.insiderHoldingPercent),
      bundlers_pct: pct(dyn.bundlerHoldingPercent),
      snipers_pct: pct(dyn.sniperHoldingPercent),
      smart_money_pct: pct(dyn.smartMoneyHoldingPercent ?? dyn.holdersSmartMoneyPercent),
      smart_money_holders: num(dyn.smartMoneyHolders),
      kol_holders: num(dyn.kolHolders),
      binance_user_holders: num(dyn.bnUniqueHolders),
      binance_users_pct: pct(dyn.bnHoldingPercent),
      bonding_pct: num(dyn.progress),
      volume_24h_usd: vol24,
      volume_1h_usd: vol1h,
      // 1h volume run-rate vs the 24h average hour — >1 = activity accelerating now
      volume_accel_x: vol24 && vol1h !== null ? Math.round((vol1h / (vol24 / 24)) * 10) / 10 : null,
      bid_share_24h_pct: vol24 && buy24 !== null ? Math.round((buy24 / vol24) * 1000) / 10 : null,
      txs_24h: num(dyn.count24h),
      market_cap_usd: num(dyn.marketCap),
      launched_at: dyn.launchTime ? new Date(dyn.launchTime).toISOString() : null,
    },
    similar_tokens: (hits ?? [])
      .filter((h) => h.contractAddress.toLowerCase() !== resolved.address!.toLowerCase())
      .sort((a, b) => (num(b.marketCap) ?? 0) - (num(a.marketCap) ?? 0))
      .slice(0, 5)
      .map((h) => ({ name: h.symbol ?? "?", chain: CHAIN_NAME[h.chainId] ?? h.chainId, market_cap_usd: num(h.marketCap) })),
  };
}
