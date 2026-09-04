import type { Resolved } from "../../types.js";
import { tokenSearch, ALL_CHAINS, num, type SearchHit } from "../../lib/binance/web3.js";
import { spotSymbolInfo } from "../../lib/binance/rest.js";
import type { BudgetGuard } from "../../pipeline/budget.js";

// Binance edition resolver — canonicalise a ticker or contract address via the
// Binance Web3 token search (the same endpoint the query-token-info skill uses),
// and note whether Binance itself lists the pair (cex_symbol). A subject that is
// listed on the exchange but has no onchain twin still resolves: the exchange is
// a venue in its own right.

const isAddress = (q: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(q) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(q);

// Prefer the deepest market among exact-symbol matches; a security-flagged
// lookalike must not outrank the real token because it happens to sort first.
const rank = (h: SearchHit): number => ((num(h.liquidity) ?? 0) + (num(h.marketCap) ?? 0) / 100) * ((h.riskLevel ?? 0) >= 3 ? 0.05 : 1);
// Among wrapped/pegged twins, Binance's own BSC peg (BTCB, ETH on BSC) is the home-venue
// twin: it is what the social-hype board and the Binance-user cohort fields key on.
const twinRank = (h: SearchHit, sym: string): number => rank(h) * (h.chainId === "56" ? 4 : 1) * ((h.symbol ?? "").toUpperCase() === `${sym}B` ? 4 : 1);

export async function resolveTokenBinance(cleaned: string, budget: BudgetGuard): Promise<Resolved | null> {
  const hits = (await tokenSearch(cleaned, ALL_CHAINS, budget)) ?? [];
  let hit: SearchHit | undefined;
  if (isAddress(cleaned)) {
    hit = hits.find((h) => h.contractAddress.toLowerCase() === cleaned.toLowerCase()) ?? hits[0];
  } else {
    const sym = cleaned.replace(/^\$/, "").toUpperCase();
    const exact = hits.filter((h) => (h.symbol ?? "").toUpperCase() === sym);
    // No exact symbol: accept the wrapped/pegged twin (BTC → BTCB on BSC, WETH) or an
    // exact name match (bitcoin → Bitcoin); never an unrelated prefix like "BT".
    const near = exact.length
      ? []
      : hits.filter((h) => {
          const hs = (h.symbol ?? "").toUpperCase();
          const hn = (h.name ?? "").toUpperCase();
          return hn === sym || (sym.length >= 3 && (hs === `${sym}B` || hs === `W${sym}` || hs === `${sym}.E`));
        });
    hit = exact.length ? exact.sort((a, b) => rank(b) - rank(a))[0] : near.sort((a, b) => twinRank(b, sym) - twinRank(a, sym))[0];
  }

  // The exchange pair: the query's own symbol first (BTC → BTCUSDT even when the onchain
  // hit is the BTCB peg), then the hit's symbol, then the hit's symbol with a peg
  // prefix/suffix stripped (WETH → ETH).
  const clean = (v: string | undefined) => (v ?? "").replace(/^\$/, "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const hitSym = clean(hit?.symbol);
  const bases = [...new Set([isAddress(cleaned) ? "" : clean(cleaned), hitSym, hitSym.replace(/B$/, ""), hitSym.replace(/^W(?=[A-Z]{3,})/, "")].filter((b) => b.length >= 2 && b.length <= 12))];
  let cexSymbol: string | null = null;
  for (const b of bases) {
    if (await spotSymbolInfo(`${b}USDT`, budget)) {
      cexSymbol = `${b}USDT`;
      break;
    }
  }
  const listed = cexSymbol !== null;
  const base = hitSym || bases[0] || clean(cleaned);
  if (!hit && !listed) return null;

  return {
    type: "token",
    name: hit?.symbol ? hit.symbol.toUpperCase() : base,
    ...(hit ? { chain: hit.chainId, address: hit.contractAddress } : {}),
    ...(cexSymbol ? { cex_symbol: cexSymbol } : {}),
  };
}
