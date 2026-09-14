import type { PredictionVenue, StockRead, StockVerdict } from "../types.js";
import { structuredCall } from "../lib/anthropic.js";
import { researchStock, type ResearchBrief } from "./research.js";
import { predictionLens } from "./prediction.js";
import { BudgetGuard } from "../pipeline/budget.js";
import { lintVerdictStrings } from "../lint.js";
import { isCliEntry } from "../fixtures.js";
import { config } from "../config.js";
import { rwaStockList, tokenDynamic, num as bnNum } from "../lib/cex/web3.js";
import { resolveRwaContract, ticker as bgTicker, currentFundRate, openInterest, num as bgNum } from "../lib/bitget/rest.js";
import { usCashSession } from "../lib/bitget/session.js";

// STOCKS lens — one company read across markets: the exchange's tokenized
// listing of the share, real-world equity research (price, earnings, the
// analyst consensus), and any prediction market on the company, then where
// they diverge. Data and analysis only — a stock is a security, so the language
// stays strictly observational (never buy/sell/hold, never a price target as advice).
//
// Bitget edition: the tokenized listing is an rToken PERPETUAL (NVDAUSDT…) that
// trades 24/7 while the underlying trades 6.5h a day. Its basis to the index
// price, its funding, and its open interest are computed here — numbers the
// synthesis may cite but never invents. CEX edition: an Ondo tokenized share
// on-chain (TSLAon…), read by price, liquidity and holders.

const IS_BITGET = config.exchange === "bitget";
const TOKENIZED_LABEL = IS_BITGET ? "Bitget-listed rToken perpetual" : "CEX-listed Ondo tokenized share";
const TOKENIZED_SHORT = IS_BITGET ? "Bitget rToken future" : "CEX tokenized share";
const TOKENIZED_HOW = IS_BITGET
  ? "the Bitget rToken perpetual — its last price, its basis to the underlying's index price, its funding and open interest (all computed), and whether the US cash session is open right now"
  : `the ${TOKENIZED_LABEL} price on-chain`;

function n(v: unknown): number | null {
  const x = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(x) ? x : null;
}

const EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    ticker: { type: "string", description: "The US-listed stock ticker in CAPS, no $ (e.g. TSLA, AAPL, NVDA). Infer from a company name if needed." },
    company: { type: "string", description: "The company name (e.g. Tesla, Apple, NVIDIA)." },
    is_stock: { type: "boolean", description: "true only if the query is about a publicly-traded company/stock; false otherwise." },
  },
  required: ["ticker", "company", "is_stock"],
  additionalProperties: false,
} as const;

const SYNTH_SCHEMA = {
  type: "object",
  properties: {
    market_snapshot: { type: "string", description: "One line: the reported real-world share price and recent move, taken from the research. Empty string if unknown." },
    analyst_consensus: { type: "string", description: "One line: the reported sell-side consensus rating and average price target, attributed as data (e.g. 'Consensus Buy, avg target $290 (per research)'). Empty string if unknown. NEVER phrase as your own recommendation." },
    consensus_tag: { type: "string", description: "The reported sell-side consensus rating in 1-2 words only (e.g. 'Strong Buy', 'Buy', 'Hold', 'Sell'). Empty string if unknown. This is reported data, never your own call." },
    catalysts: { type: "array", items: { type: "string" }, description: "0-4 concrete upcoming/recent catalysts (next earnings date, guidance, product launch, macro event)." },
    divergence: {
      type: "object",
      properties: {
        score: { type: "number", description: "0-100: how much the markets disagree about the company's outlook." },
        direction: { type: "string", description: "Short tag, e.g. 'perp ahead of cash', 'in agreement', 'research ahead of price'." },
        one_liner: { type: "string", description: "One observational sentence naming the divergence." },
        reasoning: { type: "array", items: { type: "string" }, description: "2-4 observational bullets citing the numbers/markets." },
      },
      required: ["score", "direction", "one_liner", "reasoning"],
      additionalProperties: false,
    },
    verdict_line: { type: "string", description: `One observational sentence: the cross-market read on this company. Where do the ${TOKENIZED_SHORT} price, the equity research, and any prediction market agree or disagree?` },
  },
  required: ["market_snapshot", "analyst_consensus", "catalysts", "divergence", "verdict_line"],
  additionalProperties: false,
} as const;

const SYNTH_SYSTEM =
  `You are OPTIC's stocks desk. You read one company across markets: ${TOKENIZED_HOW}, real-world equity research, and any prediction market on the company.` +
  " Report the MAP — where those markets AGREE and where they DISAGREE about the same company. Plain words: say \"market(s)\", never \"venue(s)\"; say markets \"agree/disagree\" or \"lag\", never \"diverge\". " +
  "This is a DATA product, NOT financial advice. NEVER say buy, sell, hold, long, short, or tell anyone what to do. You may REPORT the analyst consensus rating and price target as attributed data, but never issue or endorse a target yourself. Write that attribution ONLY in analyst_consensus and consensus_tag. Everywhere else — verdict_line, divergence.one_liner, divergence.reasoning — is OPTIC's own voice: call it \"analyst research\" or \"broker research\", never \"sell-side\", and never name a rating. Language is observational only: priced-in, lagging, diverging, crowded, catalyst-ahead. " +
  "Gap score 0-100 = how much the markets disagree about the company's outlook. If a market is missing, that absence is itself signal (e.g. 'no prediction market is pricing this'). Use only the facts provided; do not invent prices or numbers." +
  (IS_BITGET
    ? " When us_session_open is false the perpetual is the ONLY live price on the company right now — say so plainly. basis_pct is where the perpetual disagrees with its underlying's reference; funding_annualized_pct is what the crowd is paying to hold that disagreement. Cite them by number."
    : "");

/** CEX edition: the Ondo tokenized stock (TSLAon…) CEX Web3 lists for a ticker. */
async function findOndoStock(ticker: string, budget: BudgetGuard): Promise<StockRead["tokenized"]> {
  const list = (await rwaStockList(budget)) ?? [];
  const want = ticker.toUpperCase();
  // Prefer BSC (CEX's home chain) when the same ticker is listed on both.
  const match = list.filter((t) => (t.ticker ?? "").toUpperCase() === want).sort((a, b) => (a.chainId === "56" ? -1 : 0) - (b.chainId === "56" ? -1 : 0))[0];
  if (!match) return null;
  const dyn = await tokenDynamic(match.chainId, match.contractAddress, budget).catch(() => null);
  const mult = bnNum(match.multiplier) ?? 1;
  const price = bnNum(dyn?.price);
  return {
    symbol: match.symbol,
    venue: "onchain",
    chain: match.chainId === "56" ? "bsc" : match.chainId === "1" ? "ethereum" : match.chainId,
    address: match.contractAddress,
    // One token = `multiplier` shares; report the per-share reference price.
    price: price === null ? null : Math.round((price / (mult || 1)) * 100) / 100,
    chg_24h: bnNum(dyn?.percentChange24h),
    liquidity: bnNum(dyn?.liquidity),
    holders: bnNum(dyn?.holders),
  };
}

const round = (x: number | null, places = 2): number | null => (x === null ? null : Math.round(x * 10 ** places) / 10 ** places);

/**
 * Bitget edition: the rToken perpetual (NVDAUSDT…) Bitget lists for a ticker,
 * read as computed numbers. Nothing here is argued: basis, funding and open
 * interest come straight from the exchange, and the session flag from the clock.
 */
export async function findBitgetFuture(ticker: string, budget: BudgetGuard): Promise<StockRead["tokenized"]> {
  const contract = await resolveRwaContract(ticker, budget);
  if (!contract) return null;
  const sym = contract.symbol;
  const [tk, fr, oi] = await Promise.all([
    bgTicker(sym, budget).catch(() => null),
    currentFundRate(sym, budget).catch(() => null),
    openInterest(sym, budget).catch(() => null),
  ]);
  if (!tk) return null;

  const last = bgNum(tk.lastPr);
  const mark = bgNum(tk.markPrice);
  const index = bgNum(tk.indexPrice);
  const bid = bgNum(tk.bidPr);
  const ask = bgNum(tk.askPr);
  const fundingRate = bgNum(fr?.fundingRate ?? tk.fundingRate);
  const intervalH = bgNum(fr?.fundingRateInterval ?? contract.fundInterval) ?? 8;
  const oiContracts = oi?.size ?? bgNum(tk.holdingAmount);
  const chg = bgNum(tk.change24h); // fraction on Bitget
  const vol = bgNum(tk.usdtVolume);

  return {
    symbol: sym,
    venue: "perpetual",
    chain: "bitget-futures",
    address: "",
    price: round(last),
    chg_24h: chg === null ? null : round(chg * 100),
    liquidity: null,
    holders: null,
    mark_price: round(mark),
    index_price: round(index),
    basis_pct: mark !== null && index ? round(((mark - index) / index) * 100, 3) : null,
    funding_rate: fundingRate,
    funding_interval_h: intervalH,
    funding_annualized_pct: fundingRate === null ? null : round(fundingRate * (24 / intervalH) * 365 * 100, 2),
    open_interest: round(oiContracts, 2),
    open_interest_usdt: oiContracts !== null && mark !== null ? round(oiContracts * mark, 0) : null,
    volume_24h_usdt: round(vol, 0),
    spread_bps: bid && ask ? round(((ask - bid) / ((ask + bid) / 2)) * 10_000, 1) : null,
    us_session_open: usCashSession() === "open",
  };
}

const findTokenized = IS_BITGET ? findBitgetFuture : findOndoStock;

export async function stockRead(query: string, budget: BudgetGuard): Promise<StockVerdict> {
  const now = () => new Date().toISOString();

  const ex = await structuredCall<{ ticker: string; company: string; is_stock: boolean }>({
    label: "stock_extract",
    system: "Identify the publicly-traded company a query refers to. If it is not about a stock, set is_stock=false.",
    user: query,
    schema: EXTRACT_SCHEMA as unknown as Record<string, unknown>,
    budget,
    maxTokens: 120,
    effort: "low",
  });

  if (!ex.is_stock || !ex.ticker.trim()) {
    return {
      query,
      resolved: { type: "stock", name: query },
      stock: null,
      prediction: null,
      research: null,
      verdict_line: `"${query}" doesn't resolve to a stock — try a ticker or company (e.g. TSLA, NVIDIA, Apple).`,
      generated_at: now(),
      card_url: null,
    };
  }

  const ticker = ex.ticker.toUpperCase().replace(/[^A-Z.]/g, "");
  const company = ex.company.trim() || ticker;

  const [tokenized, research, prediction] = await Promise.all([
    findTokenized(ticker, budget).catch(() => null),
    researchStock(`${ticker} ${company} stock`, budget).catch((): ResearchBrief | null => null),
    predictionLens.read({ type: "narrative", name: company }, budget).catch((): PredictionVenue | null => null),
  ]);

  // Nothing sourced anywhere — report the gap honestly rather than invent a read.
  if (!tokenized && !research && !(prediction?.markets?.length)) {
    return {
      query,
      resolved: { type: "stock", name: company },
      stock: null,
      prediction: null,
      research: null,
      verdict_line: `${ticker}: no ${TOKENIZED_SHORT}, prediction market, or fresh research surfaced right now — nothing to read across markets.`,
      generated_at: now(),
      card_url: null,
    };
  }

  let feedback = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const synth = await structuredCall<{
      market_snapshot: string;
      analyst_consensus: string;
      consensus_tag: string;
      catalysts: string[];
      divergence: StockRead["divergence"];
      verdict_line: string;
    }>({
      label: attempt === 0 ? "stock_synth" : "stock_synth_retry",
      system: SYNTH_SYSTEM,
      user:
        JSON.stringify({
          ticker,
          company,
          // The exchange's tokenized listing. Every number in here is computed
          // from exchange data — the synthesis cites it, it does not invent it.
          tokenized_listing: tokenized,
          equity_research: research?.brief ?? null,
          prediction_markets: (prediction?.markets ?? []).slice(0, 5).map((m) => ({ q: m.question, yes: m.yes_price, chg24h: m.yes_chg_24h, vol: m.volume })),
        }) + feedback,
      schema: SYNTH_SCHEMA as unknown as Record<string, unknown>,
      budget,
      maxTokens: 900,
      effort: "medium",
    });

    // Lint the fields written in Optic's own voice. `analyst_consensus` and
    // `consensus_tag` are deliberately exempt: they carry a REPORTED sell-side
    // rating ("Strong Buy"), attributed to the analysts who published it rather
    // than said by us — that attribution is the whole reason the field exists.
    const lint = lintVerdictStrings([synth.verdict_line, synth.divergence?.one_liner, ...(synth.divergence?.reasoning ?? [])]);
    if (!lint.ok) {
      feedback = `\n\nPrevious output failed the language lint on: ${JSON.stringify(lint.violations.map((v) => v.word))}. Rewrite without those.`;
      continue;
    }

    const stock: StockRead = {
      ticker,
      company,
      tokenized,
      market_snapshot: synth.market_snapshot || null,
      analyst_consensus: synth.analyst_consensus || null,
      consensus_tag: synth.consensus_tag || null,
      catalysts: synth.catalysts ?? [],
      divergence: synth.divergence,
    };

    return {
      query,
      resolved: { type: "stock", name: company },
      stock,
      prediction: prediction?.markets?.length ? prediction : null,
      research: research ? { brief: research.brief, sources: research.sources } : null,
      verdict_line: synth.verdict_line,
      generated_at: now(),
      card_url: null,
    };
  }
  throw new Error("stock output failed banned-word lint after retry");
}

if (isCliEntry(import.meta.url)) {
  const budget = new BudgetGuard();
  stockRead(process.argv.slice(2).join(" ") || "TSLA", budget).then((v) => {
    console.log(JSON.stringify(v, null, 2));
    console.log(`cost: $${budget.total().toFixed(4)}`);
  });
}
