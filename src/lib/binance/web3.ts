import { randomUUID } from "node:crypto";
import { cacheKey, cacheGet, cacheSet } from "../../db.js";
import type { BudgetGuard } from "../../pipeline/budget.js";
import { isCliEntry } from "../../fixtures.js";

// Binance Web3 (wallet-direct) public APIs — the exact endpoints the official
// Binance Skills Hub skills call (query-token-info, query-token-audit,
// crypto-market-rank, meme-rush, trading-signal, binance-sports-ai-analyzer).
// Free, no key. Every wrapper is cache-first and budget-registered at $0 so the
// per-read COGS accounting stays honest across editions.
const BASE = "https://web3.binance.com/bapi/defi";
const TIMEOUT_MS = 10_000;
const HEADERS = {
  "Accept-Encoding": "identity",
  "User-Agent": "optic-binance/1.0 (Skill)",
  source: "agent",
} as const;

export type BnChain = "56" | "1" | "8453" | "CT_501";
export const CHAIN_NAME: Record<string, string> = { "56": "bsc", "1": "ethereum", "8453": "base", CT_501: "solana" };
export const ALL_CHAINS = "56,CT_501,1,8453";

/** Normalise any chain spelling (OKX chainIndex, names) to Binance's chainId. */
export function toBnChain(v: string | undefined | null): BnChain | null {
  if (!v) return null;
  const s = String(v).trim().toLowerCase();
  if (s === "56" || s === "bsc" || s === "bnb") return "56";
  if (s === "1" || s === "eth" || s === "ethereum") return "1";
  if (s === "8453" || s === "base") return "8453";
  if (s === "501" || s === "ct_501" || s === "sol" || s === "solana") return "CT_501";
  return null;
}

export const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Percent-ish fields arrive as either 0-1 fractions or 0-100 percents; normalise to percent. */
export const pct = (v: unknown): number | null => {
  const n = num(v);
  if (n === null) return null;
  return n <= 1 ? Math.round(n * 1000) / 10 : Math.round(n * 10) / 10;
};

export class BinanceWeb3Error extends Error {
  constructor(public readonly endpoint: string, public readonly code: string, msg: string) {
    super(`binance-web3 ${endpoint}: code=${code} ${msg}`);
    this.name = "BinanceWeb3Error";
  }
}

async function call<T>(
  endpoint: string,
  path: string,
  opts: { method?: "GET" | "POST"; body?: unknown; budget?: BudgetGuard; ttl?: number } = {}
): Promise<T | null> {
  const method = opts.method ?? "GET";
  const key = cacheKey(`bnw3:${endpoint}`, { path, body: opts.body ?? null });
  const hit = cacheGet<T | null>(key);
  if (hit !== undefined) return hit;
  opts.budget?.register(`bnw3:${endpoint}`, 0);
  try {
    const res = await fetch(BASE + path, {
      method,
      headers: method === "POST" ? { ...HEADERS, "content-type": "application/json" } : HEADERS,
      body: method === "POST" ? JSON.stringify(opts.body ?? {}) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const json = (await res.json()) as { code?: string; message?: string | null; data?: T; success?: boolean };
    if (!res.ok || (json.code !== undefined && json.code !== "000000")) {
      console.error(new BinanceWeb3Error(endpoint, json.code ?? String(res.status), json.message ?? "").message);
      return null;
    }
    const data = json.data ?? null;
    cacheSet(key, data, opts.ttl);
    return data;
  } catch (err) {
    console.error(`binance-web3 ${endpoint}: ${err}`);
    return null;
  }
}

const qs = (p: Record<string, unknown>) =>
  Object.entries(p)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");

// ── token info (query-token-info) ─────────────────────────────────────

export interface SearchHit {
  chainId: string;
  contractAddress: string;
  name?: string;
  symbol?: string;
  price?: string;
  percentChange24h?: string;
  volume24h?: string;
  marketCap?: string;
  liquidity?: string;
  createTime?: number;
  holdersTop10Percent?: string;
  holders?: string;
  riskLevel?: number;
  links?: Array<{ label: string; link: string }>;
}

export function tokenSearch(keyword: string, chainIds = ALL_CHAINS, budget?: BudgetGuard) {
  return call<SearchHit[]>("token_search", `/v5/public/wallet-direct/buw/wallet/market/token/search/ai?${qs({ keyword, chainIds })}`, { budget });
}

export interface TokenDynamic {
  price?: string;
  percentChange5m?: string;
  percentChange1h?: string;
  percentChange4h?: string;
  percentChange24h?: string;
  volume24h?: string;
  volume24hBuy?: string;
  volume24hSell?: string;
  volume1h?: string;
  volume4h?: string;
  count24h?: string;
  count1h?: string;
  marketCap?: string;
  fdv?: string;
  liquidity?: string;
  holders?: string;
  launchTime?: number;
  priceHigh24h?: string;
  priceLow24h?: string;
  top10HoldersPercentage?: string;
  holdersDevPercent?: string | null;
  holdersSmartMoneyPercent?: string | null;
  holdersInfluencersPercent?: string | null;
  kycHolderCount?: string;
  bnUniqueHolders?: string;
  bnHoldingPercent?: string;
  bnTraders?: string;
  kolHolders?: string;
  kolHoldingPercent?: string;
  smartMoneyHolders?: string;
  smartMoneyHoldingPercent?: string;
  bundlerHolders?: string;
  bundlerHoldingPercent?: string;
  sniperHoldingPercent?: string | null;
  insiderHoldingPercent?: string | null;
  devHoldingPercent?: string;
  newWalletHoldingPercent?: string;
  migrateStatus?: number | null;
  progress?: string | null;
  tags?: unknown;
}

export function tokenDynamic(chainId: string, contractAddress: string, budget?: BudgetGuard) {
  return call<TokenDynamic>("token_dynamic", `/v4/public/wallet-direct/buw/wallet/market/token/dynamic/info/ai?${qs({ chainId, contractAddress })}`, { budget });
}

export interface TokenMeta {
  name?: string;
  symbol?: string;
  chainId?: string;
  contractAddress?: string;
  decimals?: number;
  createTime?: number;
  creatorAddress?: string;
  links?: Array<{ label: string; link: string }>;
  auditInfo?: Record<string, unknown>;
  aiNarrativeFlag?: number;
}

export function tokenMeta(chainId: string, contractAddress: string, budget?: BudgetGuard) {
  return call<TokenMeta>("token_meta", `/v1/public/wallet-direct/buw/wallet/dex/market/token/meta/info/ai?${qs({ chainId, contractAddress })}`, {
    budget,
    ttl: 6 * 3600,
  });
}

// ── token security audit (query-token-audit) ──────────────────────────

export interface TokenAudit {
  hasResult?: boolean;
  isSupported?: boolean;
  riskLevelEnum?: string; // LOW | MID | HIGH …
  riskLevel?: number;
  extraInfo?: { buyTax?: string; sellTax?: string; unusualBuyTax?: boolean; unusualSellTax?: boolean; source?: string };
  riskItems?: Array<{
    id: string;
    name: string;
    description?: string;
    details?: Array<{ title: string; description?: string; isHit: boolean; riskType?: string }>;
  }>;
}

export function tokenAudit(chainId: string, contractAddress: string, budget?: BudgetGuard) {
  return call<TokenAudit>("token_audit", `/v1/public/wallet-direct/security/token/audit`, {
    method: "POST",
    body: { binanceChainId: chainId, contractAddress, requestId: randomUUID() },
    budget,
    ttl: 3600,
  });
}

// ── ranks (crypto-market-rank) ────────────────────────────────────────

export interface SocialHypeEntry {
  metaInfo: { symbol: string; chainId: string; contractAddress: string; tokenAge?: number };
  marketInfo?: { marketCap?: number; priceChange?: number };
  socialHypeInfo?: {
    socialHype?: number;
    sentiment?: string; // Positive | Negative | Neutral
    socialSummaryBrief?: string;
    socialSummaryDetail?: string;
    kolCount?: number;
    socialHypeSerialChart?: Array<{ time: number; socialHype: number }>;
    top3kolLogoList?: string[];
  };
  tagInfoList?: Record<string, Array<{ tagName: string }>>;
}

/** Social buzz leaderboard for a chain (timeRange 1 = 24h). */
export async function socialHype(chainId: string, timeRange = 1, budget?: BudgetGuard): Promise<SocialHypeEntry[] | null> {
  const d = await call<{ leaderBoardList?: SocialHypeEntry[] }>(
    "social_hype",
    `/v1/public/wallet-direct/buw/wallet/market/token/pulse/social/hype/rank/leaderboard/ai?${qs({ chainId, targetLanguage: "en", timeRange })}`,
    { budget, ttl: 300 }
  );
  return d?.leaderBoardList ?? null;
}

export interface RankToken {
  chainId: string;
  contractAddress: string;
  symbol: string;
  price?: string;
  percentChange1h?: string;
  percentChange4h?: string;
  percentChange24h?: string;
  volume1h?: string;
  volume4h?: string;
  volume24h?: string;
  count1h?: string;
  count24h?: string;
  uniqueTrader24h?: string;
  uniqueTrader1h?: string;
  liquidity?: string;
  holders?: string;
  marketCap?: string;
  launchTime?: string | number;
  tokenTag?: Record<string, Array<{ tagName: string }>>;
  auditInfo?: { riskLevel?: number; riskCodes?: string[] };
}

/** Unified rank — rankType 10 = Trending, 20 = Alpha, plus top-search / stock lists. */
export async function tokenRank(chainId: string, opts: { rankType?: number; size?: number; sortBy?: number; period?: number } = {}, budget?: BudgetGuard) {
  const rankType = opts.rankType ?? 10;
  const shared = { countMin: 10, launchTimeMin: 15, liquidityMin: 5000, uniqueTraderMin: 10, volumeMin: 10000 };
  const body: Record<string, unknown> = {
    ...(rankType === 10 || rankType === 20 ? shared : {}),
    ...(rankType === 10 ? { tagFilter: [1, 2, 3] } : {}),
    rankType,
    chainId,
    period: opts.period ?? 50,
    sortBy: opts.sortBy ?? 70,
    orderAsc: false,
    page: 1,
    size: opts.size ?? 20,
  };
  const d = await call<{ tokens?: RankToken[] }>("token_rank", `/v1/public/wallet-direct/buw/wallet/market/token/pulse/unified/rank/list/ai`, {
    method: "POST",
    body,
    budget,
    ttl: 300,
  });
  return d?.tokens ?? null;
}

export interface InflowToken {
  tokenName: string;
  ca: string;
  price?: string;
  marketCap?: string;
  volume?: string;
  priceChangeRate?: string;
  tokenRiskLevel?: number;
  liquidity?: string;
  holdersTop10Percent?: string;
  holders?: string;
  inflow?: number;
  traders?: number; // distinct smart-money traders
  launchTime?: number;
  tokenTag?: Record<string, Array<{ tagName: string }>>;
}

/** Tokens receiving the most smart-money net inflow (tagType 2 = smart money). */
export function smartMoneyInflow(chainId: string, size = 20, budget?: BudgetGuard) {
  return call<InflowToken[]>("smart_money_inflow", `/v1/public/wallet-direct/tracker/wallet/token/inflow/rank/query/ai`, {
    method: "POST",
    body: { chainId, tagType: 2, page: 1, size },
    budget,
    ttl: 300,
  });
}

// ── launchpad + topics (meme-rush) ────────────────────────────────────

export interface MemeRushToken {
  chainId: string;
  contractAddress: string;
  symbol: string;
  name?: string;
  progress?: string;
  createTime?: number;
  holders?: number;
  liquidity?: string;
  volume?: string | null;
  marketCap?: string;
  count?: number | null;
  holdersTop10Percent?: string;
  holdersDevPercent?: string;
  holdersSniperPercent?: string | null;
  holdersInsiderPercent?: string | null;
  bundlerHoldingPercent?: string | null;
  migrateStatus?: number;
  devSellPercent?: string;
  taxRateBuy?: string;
  taxRateSell?: string;
  narrativeText?: string | null;
}

/** Launchpad lifecycle feed. rankType: 10 new · 20 finalizing · 30 migrated (per the skill docs). */
export function memeRush(chainId: string, rankType = 10, limit = 20, budget?: BudgetGuard) {
  return call<MemeRushToken[]>("meme_rush", `/v1/public/wallet-direct/buw/wallet/market/token/pulse/rank/list/ai`, {
    method: "POST",
    body: { chainId, rankType, limit },
    budget,
    ttl: 120,
  });
}

export interface TopicRushItem {
  topicId: string;
  chainId: string;
  name?: { topicNameEn?: string; topicNameCn?: string };
  type?: string;
  topicLink?: string;
  createTime?: number;
  aiSummary?: { aiSummaryEn?: string };
  topicNetInflow?: string;
  topicNetInflow1h?: string;
  topicTags?: string[];
  tokenList?: Array<{ chainId: string; contractAddress: string; symbol: string; netInflow?: string; marketCap?: string | null; priceChange24h?: string | null; holders?: number | null }>;
}

/** AI-detected hot narratives with the tokens riding them, ranked by inflow. */
export function topicRush(chainId: string, budget?: BudgetGuard) {
  return call<TopicRushItem[]>("topic_rush", `/v2/public/wallet-direct/buw/wallet/market/token/social-rush/rank/list/ai?${qs({ chainId, rankType: 10, sort: 10, asc: false })}`, {
    budget,
    ttl: 300,
  });
}

// ── smart-money signals (trading-signal) ──────────────────────────────

export interface SmartSignal {
  signalId: number;
  ticker: string;
  chainId: string;
  contractAddress: string;
  smartSignalType?: string;
  smartMoneyCount?: number;
  direction?: "buy" | "sell";
  signalTriggerTime?: number;
  totalTokenValue?: string; // USD value of the trade(s)
  alertPrice?: string;
  alertMarketCap?: string;
  currentPrice?: string;
  currentMarketCap?: string;
  exitRate?: number;
  status?: string;
  maxGain?: string;
  signalCount?: number;
  tokenTag?: Record<string, Array<{ tagName: string }>>;
}

export function smartMoneySignals(chainId: string, pageSize = 50, budget?: BudgetGuard) {
  return call<SmartSignal[]>("smart_money_signals", `/v1/public/wallet-direct/buw/wallet/web/signal/smart-money/ai`, {
    method: "POST",
    body: { chainId, page: 1, pageSize },
    budget,
    ttl: 120,
  });
}

// ── World Cup assistant (binance-sports-ai-analyzer) ──────────────────

export interface WcMatch {
  event_slug?: string;
  canonical_match_id?: string;
  home_team?: { name?: string; id?: string; fifa_code?: string };
  away_team?: { name?: string; id?: string; fifa_code?: string };
  kickoff_at?: string;
  match_date?: string;
  status?: string;
  tournament?: string;
  stage?: string;
  group_code?: string;
}

export function wcRecentUnfinished(budget?: BudgetGuard) {
  return call<string[]>("wc_recent", `/v1/public/wc-assistant/match/recent-unfinished`, { budget, ttl: 600 });
}

export function wcResolveBySlug(slugs: string[], budget?: BudgetGuard) {
  return call<WcMatch[]>("wc_resolve", `/v1/public/wc-assistant/match/resolve-by-slug`, { method: "POST", body: { slugs: slugs.slice(0, 50) }, budget, ttl: 600 });
}

export interface WcPrediction {
  home_win_prob?: number;
  draw_prob?: number;
  away_win_prob?: number;
  market_prob_home_win?: number | null;
  market_prob_draw?: number | null;
  market_prob_away_win?: number | null;
  market_volume_24h?: number | null;
  signals?: Array<{ signal_id: string; team_side?: string; enabled?: boolean; reason?: string; source?: string; prob_home_win_impact?: number; prob_away_win_impact?: number; prob_draw_impact?: number }>;
  computed_at?: string;
}

export function wcPrediction(cmid: string, budget?: BudgetGuard) {
  return call<WcPrediction>("wc_prediction", `/v1/public/wc-assistant/match/prediction/${encodeURIComponent(cmid)}`, { budget, ttl: 300 });
}

export function wcNewsInsights(cmid: string, budget?: BudgetGuard) {
  return call<{ events?: Array<{ title?: string; summary?: string; last_updated_at?: string; related_team_ids?: string[] }> }>(
    "wc_news",
    `/v1/public/wc-assistant/match/news-insights/${encodeURIComponent(cmid)}`,
    { budget, ttl: 600 }
  );
}

export function wcMasterAnalysis(cmid: string, budget?: BudgetGuard) {
  return call<{ analyses?: Array<{ direction?: string; analysis?: string }> }>("wc_master", `/v1/public/wc-assistant/match/master-analysis/${encodeURIComponent(cmid)}`, {
    budget,
    ttl: 600,
  });
}

/** Binance Wallet prediction-market detail for a WC match slug (marketTopicId + outcomes). */
export function predictionMarketDetailBySlug(slug: string, budget?: BudgetGuard) {
  return call<Record<string, unknown>>("pm_detail_by_slug", `/v1/public/wallet-direct/prediction/web/market/detail-by-slug`, {
    method: "POST",
    body: { slug },
    budget,
    ttl: 120,
  });
}

if (isCliEntry(import.meta.url)) {
  const [cmd = "search", arg = "pepe", arg2] = process.argv.slice(2);
  const out =
    cmd === "search" ? await tokenSearch(arg)
    : cmd === "dynamic" ? await tokenDynamic(arg2 ?? "56", arg)
    : cmd === "meta" ? await tokenMeta(arg2 ?? "56", arg)
    : cmd === "audit" ? await tokenAudit(arg2 ?? "56", arg)
    : cmd === "hype" ? await socialHype(arg)
    : cmd === "topics" ? await topicRush(arg)
    : cmd === "rush" ? await memeRush(arg, Number(arg2 ?? 10), 10)
    : cmd === "rank" ? await tokenRank(arg)
    : cmd === "signals" ? await smartMoneySignals(arg, 10)
    : cmd === "inflow" ? await smartMoneyInflow(arg, 10)
    : cmd === "wc" ? await wcRecentUnfinished()
    : cmd === "wcresolve" ? await wcResolveBySlug([arg])
    : cmd === "wcpred" ? await wcPrediction(arg)
    : cmd === "wcnews" ? await wcNewsInsights(arg)
    : cmd === "pmslug" ? await predictionMarketDetailBySlug(arg)
    : null;
  console.log(JSON.stringify(out, null, 2)?.slice(0, 6000));
}

// ── tokenized stocks (binance-tokenized-securities-info) ──────────────

export interface RwaStock {
  chainId: string;
  contractAddress: string;
  symbol: string; // e.g. TSLAon
  ticker: string; // e.g. TSLA
  type?: number;
  assetType?: number;
  multiplier?: string; // token = multiplier shares
  d?: number;
}

/** Every Ondo tokenized US stock Binance Web3 lists (type 1 = Ondo). Cached a day. */
export function rwaStockList(budget?: BudgetGuard) {
  return call<RwaStock[]>("rwa_stock_list", `/v1/public/wallet-direct/buw/wallet/market/token/rwa/stock/detail/list/ai?type=1`, { budget, ttl: 24 * 3600 });
}

// ── Binance Wallet prediction markets (Predict.fun-backed, BNB Chain) ──
// The public web API behind Binance Wallet's prediction-market tab — the same
// data the Agentic Wallet's `baw prediction market …` commands read. Markets are
// USDT-collateralised outcome tokens on BNB Chain (vendor PREDICT_FUN).
const PM = "/v1/public/wallet-direct/prediction/web";

export interface PmOutcome {
  name: string; // Yes | No | Up | Down | <entrant>
  price: number; // 0-1
  chance?: number;
  index?: number;
  tokenId?: string;
  winner?: boolean | null;
}

export interface PmMarket {
  marketId: number;
  title: string;
  question?: string;
  status?: string; // REGISTERED | RESOLVED …
  tradingStatus?: string; // OPEN | CLOSED …
  tradeVolume?: number;
  liquidity?: number;
  outcomes: PmOutcome[];
  conditionId?: string;
}

export interface PmTopic {
  marketTopicId: number;
  vendor?: string;
  chainId?: number;
  slug: string;
  eventSlug?: string | null;
  title: string;
  question?: string;
  topicType?: string; // FLAT | GROUPED
  marketVariant?: string; // DEFAULT | CRYPTO_UP_DOWN | SPORTS_MATCH …
  symbol?: string | null; // CRYPTO_UP_DOWN: e.g. BTCUSDT
  variantData?: { type?: string; startPrice?: number; endPrice?: number | null; priceFeedProvider?: string } | null;
  participantCount?: number;
  collateral?: string;
  markets: PmMarket[];
  tradeVolume?: number;
  liquidity?: number;
  l1Categories?: string[];
  l2Categories?: string[];
  tags?: string[];
  startDate?: number;
  endDate?: number;
  status?: string;
  liveStatus?: string | null;
}

export function pmSearch(query: string, limit = 10, budget?: BudgetGuard) {
  return call<PmTopic[]>("pm_search", `${PM}/market/search`, { method: "POST", body: { query: query.slice(0, 200), limit: Math.min(limit, 50) }, budget, ttl: 120 });
}

export interface PmListOpts {
  l1Category?: string; // crypto | sports | esports | economy | tech | politics | finance | culture
  l2Category?: string;
  sortBy?: "RECOMMENDED" | "VOLUME" | "PARTICIPANTS" | "CREATED_TIME" | "END_DATE";
  orderBy?: "ASC" | "DESC";
  offset?: number;
  limit?: number;
}

export async function pmList(opts: PmListOpts = {}, budget?: BudgetGuard): Promise<PmTopic[] | null> {
  const d = await call<{ marketTopics?: PmTopic[]; total?: number; hasMore?: boolean }>("pm_list", `${PM}/market/list`, {
    method: "POST",
    body: { sortBy: "VOLUME", orderBy: "DESC", offset: 0, limit: 20, ...opts },
    budget,
    ttl: 120,
  });
  return d?.marketTopics ?? null;
}

export function pmDetail(slug: string, budget?: BudgetGuard) {
  return call<PmTopic>("pm_detail", `${PM}/market/detail-by-slug`, { method: "POST", body: { slug }, budget, ttl: 60 });
}

export function pmCategories(budget?: BudgetGuard) {
  return call<{ categories?: Array<{ id: string; name: string; subcategories?: Array<{ id: string; name: string }> }> }>("pm_categories", `${PM}/category/list`, {
    method: "POST",
    body: {},
    budget,
    ttl: 3600,
  });
}

/** Public page for a Binance Wallet prediction market topic. */
export const pmUrl = (slug: string, grouped = false): string => `https://web3.binance.com/prediction/detail/${slug}${grouped ? "?topicType=grouped" : ""}`;

/** The outcome that answers "yes / up / this entrant" for a market. */
export function pmYesOutcome(m: PmMarket): PmOutcome | null {
  if (!m.outcomes?.length) return null;
  return m.outcomes.find((o) => /^(yes|up)$/i.test(o.name)) ?? m.outcomes[0];
}
