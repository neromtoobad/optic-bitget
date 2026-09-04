import { createHmac } from "node:crypto";
import { config } from "../config.js";
import { cacheKey, cacheGet, cacheSet } from "../db.js";
import type { BudgetGuard } from "../pipeline/budget.js";

const BASE = "https://web3.okx.com";
const TIMEOUT_MS = 10_000;

// Post-quota worst-case per-call cost (docs Jul 6; first 100K/mo per tier are free).
// Registered with the budget guard so COGS stays honest even past the free quota.
const TIER_COST: Record<Tier, number> = { free: 0, basic: 0.0001, premium: 0.0002 };
type Tier = "free" | "basic" | "premium";

export class OkxError extends Error {
  constructor(public readonly endpoint: string, public readonly code: string, msg: string) {
    super(`okx ${endpoint}: code=${code} ${msg}`);
    this.name = "OkxError";
  }
}

function signedHeaders(method: string, requestPath: string, body = ""): Record<string, string> {
  const ts = new Date().toISOString();
  const sign = createHmac("sha256", config.okx.secretKey)
    .update(ts + method + requestPath + body)
    .digest("base64");
  return {
    "OK-ACCESS-KEY": config.okx.apiKey,
    "OK-ACCESS-SIGN": sign,
    "OK-ACCESS-TIMESTAMP": ts,
    "OK-ACCESS-PASSPHRASE": config.okx.passphrase,
    "Content-Type": "application/json",
  };
}

/**
 * Cache-first, budget-registered OKX Market API call.
 * Returns the `data` payload, or null on any failure — lenses never throw
 * through the pipeline. code=0 with data:null is passed through as null
 * (the honest-null path, e.g. a non-trenches token on tokenDetails).
 */
async function call<T>(
  endpoint: string,
  requestPath: string,
  opts: { tier: Tier; budget?: BudgetGuard; method?: "GET" | "POST"; body?: unknown }
): Promise<T | null> {
  const method = opts.method ?? "GET";
  const key = cacheKey(`okx:${endpoint}`, { requestPath, body: opts.body ?? null });
  const hit = cacheGet<T | null>(key);
  if (hit !== undefined) return hit;

  // Budget check happens BEFORE the external call; throws BudgetExceededError.
  opts.budget?.register(`okx:${endpoint}`, TIER_COST[opts.tier]);

  const bodyStr = opts.body === undefined ? "" : JSON.stringify(opts.body);
  try {
    const res = await fetch(BASE + requestPath, {
      method,
      headers: signedHeaders(method, requestPath, bodyStr),
      body: opts.body === undefined ? undefined : bodyStr,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const json = (await res.json()) as { code?: string; msg?: string; data?: T };
    if (res.status !== 200 || json.code !== "0") {
      console.error(new OkxError(endpoint, json.code ?? String(res.status), json.msg ?? "").message);
      return null;
    }
    const data = json.data ?? null;
    cacheSet(key, data);
    return data;
  } catch (err) {
    console.error(`okx ${endpoint}: ${err}`);
    return null;
  }
}

// ── endpoints OPTIC uses ──────────────────────────────────────────────

export interface SearchToken {
  tokenSymbol?: string;
  symbol?: string;
  tokenContractAddress?: string;
  tokenAddress?: string;
  chainIndex?: string;
  [k: string]: unknown;
}

export function tokenSearch(query: string, chains: string, budget?: BudgetGuard) {
  return call<Array<{ tokenInfos?: SearchToken[] } & SearchToken>>(
    "token_search",
    `/api/v6/dex/market/token/search?search=${encodeURIComponent(query)}&chains=${chains}`,
    { tier: "basic", budget }
  );
}

export function sentiment(symbol: string, budget?: BudgetGuard) {
  // timeFrame=3 → last 24h
  return call<{
    details?: Array<{
      tokenSymbol: string;
      mentionCount: string;
      sentiment: { bullishRatio: string; bearishRatio: string; label: string };
    }>;
  }>(
    "social_sentiment",
    `/api/v6/dex/market/social/sentiment/symbol?tokenSymbols=${encodeURIComponent(symbol)}&timeFrame=3`,
    { tier: "basic", budget }
  );
}

export function vibeTimeline(chainIndex: string, tokenAddress: string, budget?: BudgetGuard) {
  // timeFrame=1 → last 24h
  return call<{
    summary?: {
      score: string;
      scoreChangeRate: string;
      engagement: string;
      engagementChangeRate: string;
      impressions: string;
      mentionsCount: string;
    };
  }>(
    "social_vibe",
    `/api/v6/dex/market/social/vibe/timeline?chainIndex=${chainIndex}&tokenAddress=${tokenAddress}&timeFrame=1`,
    { tier: "basic", budget }
  );
}

export function topKols(chainIndex: string, tokenAddress: string, budget?: BudgetGuard) {
  return call<{
    kols?: Array<{ handle: string; nickname?: string; impressions: string; followers: string }>;
  }>(
    "social_top_kols",
    `/api/v6/dex/market/social/vibe/top-kols?chainIndex=${chainIndex}&tokenAddress=${tokenAddress}&sortBy=3&timeFrame=1&limit=5`,
    { tier: "basic", budget }
  );
}

export function priceInfo(chainIndex: string, tokenContractAddress: string, budget?: BudgetGuard) {
  return call<
    Array<{
      price: string;
      priceChange24H: string;
      liquidity: string;
      marketCap: string;
      holders: string;
      txs24H: string;
    }>
  >("price_info", `/api/v6/dex/market/price-info`, {
    tier: "premium",
    budget,
    method: "POST",
    body: [{ chainIndex, tokenContractAddress }],
  });
}

export function memeTokenDetails(chainIndex: string, tokenContractAddress: string, budget?: BudgetGuard) {
  return call<{
    symbol?: string;
    bondingPercent?: string;
    tags?: {
      top10HoldingsPercent?: string;
      devHoldingsPercent?: string;
      insidersPercent?: string;
      bundlersPercent?: string;
      snipersPercent?: string;
      totalHolders?: string;
    };
    market?: { marketCapUsd?: string; volumeUsd1h?: string };
  }>(
    "memepump_details",
    `/api/v6/dex/market/memepump/tokenDetails?chainIndex=${chainIndex}&tokenContractAddress=${tokenContractAddress}`,
    { tier: "premium", budget }
  );
}

export function memeDevInfo(chainIndex: string, tokenContractAddress: string, budget?: BudgetGuard) {
  return call<Record<string, unknown>>(
    "memepump_dev",
    `/api/v6/dex/market/memepump/tokenDevInfo?chainIndex=${chainIndex}&tokenContractAddress=${tokenContractAddress}`,
    { tier: "premium", budget }
  );
}

export function similarTokens(chainIndex: string, tokenContractAddress: string, budget?: BudgetGuard) {
  return call<Array<{ tokenSymbol?: string; tokenAddress?: string; marketCapUsd?: string; createdTimestamp?: string }>>(
    "memepump_similar",
    `/api/v6/dex/market/memepump/similarToken?chainIndex=${chainIndex}&tokenContractAddress=${tokenContractAddress}`,
    { tier: "basic", budget }
  );
}

export interface RankingDetail {
  tokenSymbol: string;
  mentionCount: string;
  xMentionCount?: string;
  newsMentionCount?: string;
  sentiment?: { bullishRatio: string; bearishRatio: string; label: string };
}

export function sentimentRanking(timeFrame: "1" | "2" | "3", limit: number, budget?: BudgetGuard) {
  // timeFrame: 1=1h, 2=4h, 3=24h
  return call<{ details?: RankingDetail[] }>(
    "social_ranking",
    `/api/v6/dex/market/social/sentiment/ranking?timeFrame=${timeFrame}&limit=${limit}`,
    { tier: "basic", budget }
  );
}

export interface NewsArticle {
  id: string;
  title: string;
  summary?: string;
  importance?: string;
  source?: string;
  sourceUrl?: string;
  timestamp?: number;
  tokenSymbols?: string[];
}

export function newsSearch(keyword: string, limit: number, budget?: BudgetGuard) {
  return call<{ articles?: NewsArticle[] }>(
    "news_search",
    `/api/v6/dex/market/social/news/search?keyword=${encodeURIComponent(keyword)}&limit=${limit}`,
    { tier: "basic", budget }
  );
}

export function memeTokenList(stage: "NEW" | "MIGRATING" | "MIGRATED", size: number, budget?: BudgetGuard) {
  return call<
    Array<{
      symbol?: string;
      name?: string;
      tokenAddress?: string;
      createdTimestamp?: string;
      market?: { marketCapUsd?: string; volumeUsd1h?: string; txCount1h?: string };
      tags?: { totalHolders?: string };
    }>
  >(
    "memepump_list",
    `/api/v6/dex/market/memepump/tokenList?chainIndex=501&protocolId=1&rankType=2&size=${size}&stage=${stage}`,
    { tier: "premium", budget }
  );
}

export function clusterOverview(chainIndex: string, tokenContractAddress: string, budget?: BudgetGuard) {
  return call<{
    clusterConcentration?: string;
    holderNewAddressPercent?: string;
    holderSameCreationTimePercent?: string;
    holderSameFundSourcePercent?: string;
    rugPullPercent?: string;
    top100HoldingsPercent?: string;
  }>(
    "cluster_overview",
    `/api/v6/dex/market/token/cluster/overview?chainIndex=${chainIndex}&tokenContractAddress=${tokenContractAddress}`,
    { tier: "premium", budget }
  );
}

export function advancedInfo(chainIndex: string, tokenContractAddress: string, budget?: BudgetGuard) {
  return call<{
    bundleHoldingPercent?: string;
    devHoldingPercent?: string;
    devCreateTokenCount?: string;
    devLaunchedTokenCount?: string;
    devRugPullTokenCount?: string;
    lpBurnedPercent?: string;
    riskControlLevel?: string;
    tokenTags?: string[];
  }>(
    "advanced_info",
    `/api/v6/dex/market/token/advanced-info?chainIndex=${chainIndex}&tokenContractAddress=${tokenContractAddress}`,
    { tier: "premium", budget }
  );
}

export interface SignalTx {
  token?: { symbol?: string; name?: string; tokenAddress?: string; marketCapUsd?: string; holders?: string; top10HolderPercent?: string };
  amountUsd?: string;
  price?: string;
  timestamp?: string;
  triggerWalletCount?: string; // how many smart wallets triggered this buy signal
  chainIndex?: string;
}

/** Smart-money BUY-signal feed (POST). Tokens sharp wallets are accumulating. */
export function smartMoneySignals(chainIndex: string, budget?: BudgetGuard) {
  return call<SignalTx[]>("signal_list", `/api/v6/dex/market/signal/list`, {
    tier: "premium",
    budget,
    method: "POST",
    body: { chainIndex },
  });
}

export const num = (s: string | number | undefined | null): number | null => {
  if (s === undefined || s === null || s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
