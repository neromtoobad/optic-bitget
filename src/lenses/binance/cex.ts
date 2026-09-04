import type { BinanceVenue, Lens, Resolved } from "../../types.js";
import {
  spotTicker24h,
  spotSymbolInfo,
  futuresPremiumIndex,
  futuresOpenInterest,
  futuresOpenInterestHist,
  futuresLongShortRatio,
  futuresTakerRatio,
  num,
} from "../../lib/binance/rest.js";
import { mcpMarketSnapshot } from "../../lib/binance/mcp.js";
import { BudgetGuard } from "../../pipeline/budget.js";
import { isCliEntry } from "../../fixtures.js";

// BINANCE venue lens — the exchange's read of the same story: spot price and
// the perps positioning around it (funding, open interest, account skew, taker
// flow). Spot comes through the Binance MCP Server when this deployment is
// authorised (the Agent OS path), else through Binance's public REST API — same
// numbers, different door; `source` says which. Perps series come from the
// public futures data API either way.

// Plain-word subjects that map to a listed major. Kept deliberately short: an
// arbitrary narrative must not be forced onto a ticker.
const ALIASES: Record<string, string> = {
  bitcoin: "BTC",
  btc: "BTC",
  ethereum: "ETH",
  ether: "ETH",
  eth: "ETH",
  solana: "SOL",
  sol: "SOL",
  bnb: "BNB",
  binance: "BNB",
  xrp: "XRP",
  ripple: "XRP",
  doge: "DOGE",
  dogecoin: "DOGE",
  cardano: "ADA",
  ada: "ADA",
  avalanche: "AVAX",
  avax: "AVAX",
  chainlink: "LINK",
  link: "LINK",
  polkadot: "DOT",
  dot: "DOT",
  tron: "TRX",
  trx: "TRX",
  litecoin: "LTC",
  ltc: "LTC",
  sui: "SUI",
  hyperliquid: "HYPE",
  hype: "HYPE",
  pepe: "PEPE",
  shiba: "SHIB",
  shib: "SHIB",
  bonk: "BONK",
  wif: "WIF",
  dogwifhat: "WIF",
  trump: "TRUMP",
  ton: "TON",
  toncoin: "TON",
  near: "NEAR",
  aptos: "APT",
  apt: "APT",
  arbitrum: "ARB",
  arb: "ARB",
  optimism: "OP",
  op: "OP",
  polygon: "POL",
  pol: "POL",
  uniswap: "UNI",
  uni: "UNI",
  aave: "AAVE",
  worldcoin: "WLD",
  wld: "WLD",
  fartcoin: "FARTCOIN",
  pump: "PUMP",
};

function candidateBase(resolved: Resolved): string | null {
  if (resolved.type === "token") {
    const s = resolved.name.replace(/^\$/, "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    return s.length >= 2 && s.length <= 12 ? s : null;
  }
  // Narrative: only an explicit alias hit ("bitcoin etf", "will eth flip btc" → the
  // first alias in word order), never a guess.
  const words = resolved.name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (const w of words) if (ALIASES[w]) return ALIASES[w];
  return null;
}

/** The Binance spot pair this subject trades as, if listed (cached). */
export async function resolveCexSymbol(resolved: Resolved, budget?: BudgetGuard): Promise<string | null> {
  if (resolved.cex_symbol) return resolved.cex_symbol;
  const base = candidateBase(resolved);
  if (!base) return null;
  // A pegged twin (BTCB, WETH) trades on the exchange under its plain symbol.
  const candidates = [...new Set([base, base.replace(/B$/, ""), base.replace(/^W(?=[A-Z]{3,})/, "")].filter((b) => b.length >= 2))];
  for (const b of candidates) {
    const symbol = `${b}USDT`;
    if (await spotSymbolInfo(symbol, budget)) return symbol;
  }
  return null;
}

const round = (n: number | null, d = 2): number | null => (n === null ? null : Math.round(n * 10 ** d) / 10 ** d);
const fmtUsd = (n: number | null): string => {
  if (n === null) return "?";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
};
const fmtPrice = (n: number | null): string => {
  if (n === null) return "?";
  if (n >= 1000) return `$${Math.round(n).toLocaleString("en-US")}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toPrecision(3)}`;
};
const signed = (n: number | null, d = 2, suffix = "%"): string => (n === null ? "?" : `${n > 0 ? "+" : ""}${n.toFixed(d)}${suffix}`);

export async function binanceVenueRead(resolved: Resolved, budget: BudgetGuard): Promise<BinanceVenue | null> {
  const symbol = await resolveCexSymbol(resolved, budget);
  if (!symbol) return null;

  // Spot: MCP first (the Agent OS door), REST second (same public numbers).
  let source: BinanceVenue["source"] = "binance-api";
  let spot: BinanceVenue["spot"] = null;
  let mcpFunding: number | null = null;
  const mcp = await mcpMarketSnapshot(symbol, budget).catch(() => null);
  if (mcp && mcp.price !== null) {
    source = "binance-mcp";
    spot = { price: mcp.price, chg_24h: round(mcp.chg_24h), volume_24h_usd: mcp.quote_volume_24h, high_24h: mcp.high_24h, low_24h: mcp.low_24h };
    mcpFunding = mcp.funding_rate;
  }
  if (!spot) {
    const t = await spotTicker24h(symbol, budget);
    if (t) {
      spot = {
        price: num(t.lastPrice),
        chg_24h: round(num(t.priceChangePercent)),
        volume_24h_usd: num(t.quoteVolume),
        high_24h: num(t.highPrice),
        low_24h: num(t.lowPrice),
      };
    }
  }

  // Perps positioning (public futures data; null when Binance lists no perp).
  const [prem, oi, oiHist, ls, taker] = await Promise.all([
    futuresPremiumIndex(symbol, budget),
    futuresOpenInterest(symbol, budget),
    futuresOpenInterestHist(symbol, budget),
    futuresLongShortRatio(symbol, budget),
    futuresTakerRatio(symbol, budget),
  ]);

  let perps: BinanceVenue["perps"] = null;
  if (prem) {
    const mark = num(prem.markPrice);
    const funding = mcpFunding ?? num(prem.lastFundingRate);
    const oiContracts = num(oi?.openInterest);
    const oiUsd = oiContracts !== null && mark !== null ? oiContracts * mark : null;
    let oiChg: number | null = null;
    if (oiHist && oiHist.length >= 2) {
      const first = num(oiHist[0].sumOpenInterestValue);
      const last = num(oiHist[oiHist.length - 1].sumOpenInterestValue);
      if (first && last) oiChg = round(((last - first) / first) * 100, 1);
    }
    const lsRow = ls?.[0];
    const takerRow = taker?.[0];
    perps = {
      mark_price: mark,
      funding_rate: funding,
      funding_annualized_pct: funding === null ? null : round(funding * 3 * 365 * 100, 1),
      next_funding_at: prem.nextFundingTime ? new Date(prem.nextFundingTime).toISOString() : null,
      open_interest: oiContracts,
      open_interest_usd: oiUsd,
      open_interest_chg_24h: oiChg,
      accounts_up_pct: lsRow ? round((num(lsRow.longAccount) ?? 0) * 100, 1) : null,
      accounts_up_down_ratio: lsRow ? round(num(lsRow.longShortRatio), 2) : null,
      taker_flow_ratio: takerRow ? round(num(takerRow.buySellRatio), 2) : null,
    };
  }
  if (!spot && !perps) return null;

  const basis = spot?.price && perps?.mark_price ? round(((perps.mark_price - spot.price) / spot.price) * 100, 3) : null;
  return { symbol, source, spot, perps, basis_pct: basis, read: composeRead(symbol, spot, perps, basis) };
}

/** One factual line for the exchange read. Pure, and phrased to pass the language lint. */
export function composeRead(symbol: string, spot: BinanceVenue["spot"], perps: BinanceVenue["perps"], basis: number | null): string {
  const parts: string[] = [];
  if (spot) parts.push(`${symbol} ${fmtPrice(spot.price)} (${signed(spot.chg_24h)} 24h, ${fmtUsd(spot.volume_24h_usd)} volume) on Binance spot`);
  if (perps) {
    const bits: string[] = [];
    if (perps.funding_rate !== null) bits.push(`funding ${signed(perps.funding_rate * 100, 4)}/8h (≈${signed(perps.funding_annualized_pct, 1)} annualised)`);
    if (perps.open_interest_usd !== null) bits.push(`open interest ${fmtUsd(perps.open_interest_usd)}${perps.open_interest_chg_24h !== null ? ` (${signed(perps.open_interest_chg_24h, 1)} 24h)` : ""}`);
    if (perps.accounts_up_pct !== null) bits.push(`${perps.accounts_up_pct}% of accounts positioned for a rise`);
    if (perps.taker_flow_ratio !== null) bits.push(`taker flow ratio ${perps.taker_flow_ratio}`);
    if (basis !== null) bits.push(`perp basis ${signed(basis, 3)}`);
    if (bits.length) parts.push(`perps: ${bits.join(" · ")}`);
  }
  return parts.join("; ");
}

export const binanceVenueLens: Lens<BinanceVenue> = { name: "binance", read: binanceVenueRead };

if (isCliEntry(import.meta.url)) {
  const budget = new BudgetGuard();
  const q = process.argv[2] ?? "BTC";
  const resolved: Resolved = /^[A-Za-z0-9$]{2,12}$/.test(q) ? { type: "token", name: q } : { type: "narrative", name: q };
  const out = await binanceVenueRead(resolved, budget);
  console.log(JSON.stringify({ resolved, binance: out }, null, 2));
  console.log(`cost: $${budget.total().toFixed(5)}`);
}
