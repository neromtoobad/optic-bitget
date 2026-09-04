import type { Lens, MemeVenue, Resolved } from "../types.js";
import { priceInfo, memeTokenDetails, similarTokens, num } from "../lib/okx.js";
import { BudgetGuard } from "../pipeline/budget.js";
import { isCliEntry } from "../fixtures.js";
import { config } from "../config.js";
import { onchainBinance } from "./binance/onchain.js";

// MEME lens — onchain reality: price/liquidity/holders (price-info) +
// Trenches scanner data (dev flags, similar tokens) when the token lives there.
export const memeLens: Lens<MemeVenue> = {
  name: "meme",
  async read(resolved: Resolved, budget: BudgetGuard): Promise<MemeVenue | null> {
    if (config.exchange === "binance") return onchainBinance(resolved, budget);
    if (resolved.type !== "token" || !resolved.address || !resolved.chain) return null;

    const [info, details, similar] = await Promise.all([
      priceInfo(resolved.chain, resolved.address, budget),
      memeTokenDetails(resolved.chain, resolved.address, budget),
      similarTokens(resolved.chain, resolved.address, budget),
    ]);

    const p = info?.[0];
    if (!p && !details) return null;

    const tags = details?.tags;
    return {
      price: num(p?.price),
      chg_24h: num(p?.priceChange24H),
      liquidity: num(p?.liquidity),
      holders: num(p?.holders) ?? num(tags?.totalHolders),
      dev_flags: tags
        ? {
            dev_holdings_pct: num(tags.devHoldingsPercent),
            top10_pct: num(tags.top10HoldingsPercent),
            insiders_pct: num(tags.insidersPercent),
            bundlers_pct: num(tags.bundlersPercent),
            snipers_pct: num(tags.snipersPercent),
            bonding_pct: num(details?.bondingPercent),
          }
        : null,
      similar_tokens: (similar ?? []).slice(0, 5).map((s) => ({
        name: s.tokenSymbol ?? "?",
        chain: resolved.chain!,
        market_cap_usd: num(s.marketCapUsd),
      })),
    };
  },
};

if (isCliEntry(import.meta.url)) {
  const { resolve } = await import("./resolve.js");
  const budget = new BudgetGuard();
  const resolved = await resolve(process.argv[2] ?? "pepe", budget);
  if (resolved.type !== "token" && resolved.type !== "narrative") throw new Error("this CLI expects a token/narrative query");
  const out = await memeLens.read(resolved, budget);
  console.log(JSON.stringify({ resolved, meme: out }, null, 2));
  console.log(`cost: $${budget.total().toFixed(5)}`);
}
