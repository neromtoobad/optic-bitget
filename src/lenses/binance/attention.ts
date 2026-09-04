import type { Attention, Resolved } from "../../types.js";
import { socialHype, topicRush, toBnChain, type SocialHypeEntry, type TopicRushItem } from "../../lib/binance/web3.js";
import type { BudgetGuard } from "../../pipeline/budget.js";

// ATTENTION lens (Binance edition) — where the crowd is, from Binance Web3's
// social-hype leaderboard (mention-weighted hype, sentiment label, an AI summary
// of what people are saying, KOL count, a 24h series) and, for narratives, the
// topic radar (AI-detected hot narratives with the tokens riding them).
// Hotness is 0-100 relative to the day's loudest token on the board — the
// leader (usually BTC) is 100, so a 40 means "40% of the leader on a log scale".

const BOARD_CHAINS = ["56", "CT_501", "8453"] as const;

function hotness(entry: SocialHypeEntry, max: number): number | null {
  const h = entry.socialHypeInfo?.socialHype;
  if (h == null || max <= 0) return null;
  return Math.round((100 * Math.log1p(h)) / Math.log1p(max) * 10) / 10;
}

function trendOf(entry: SocialHypeEntry): { trend: string; change_pct: number | null } {
  const series = entry.socialHypeInfo?.socialHypeSerialChart ?? [];
  if (series.length < 6) return { trend: "unknown", change_pct: null };
  const head = series.slice(0, Math.min(6, Math.floor(series.length / 2)));
  const tail = series.slice(-Math.min(6, Math.floor(series.length / 2)));
  const avg = (xs: typeof series) => xs.reduce((a, x) => a + (x.socialHype ?? 0), 0) / xs.length;
  const a = avg(head);
  const b = avg(tail);
  if (a <= 0) return { trend: "unknown", change_pct: null };
  const chg = Math.round(((b - a) / a) * 1000) / 10;
  return { trend: chg > 15 ? "rising" : chg < -15 ? "falling" : "flat", change_pct: chg };
}

export interface BoardHit {
  entry: SocialHypeEntry;
  chain: string;
  max: number;
}

/** Find a token on the social-hype boards: same chain+address first, then any board by symbol. */
export async function findOnBoards(resolved: Resolved, budget: BudgetGuard): Promise<BoardHit | null> {
  const own = toBnChain(resolved.chain);
  const chains = [...new Set([...(own ? [own] : []), ...BOARD_CHAINS])];
  const boards = await Promise.all(chains.map((c) => socialHype(c, 1, budget).then((b) => ({ chain: c, board: b ?? [] }))));
  const sym = resolved.name.toUpperCase();
  // The board keys majors by their plain symbol (BTC for BTCB, ETH for WETH); accept the
  // unwrapped spelling so a pegged twin still finds its story.
  const variants = [...new Set([sym, sym.replace(/^W(?=[A-Z]{3,})/, ""), sym.replace(/B$/, "")].filter((v) => v.length >= 2))];
  for (const { chain, board } of boards) {
    const max = Math.max(0, ...board.map((e) => e.socialHypeInfo?.socialHype ?? 0));
    const byAddr = resolved.address ? board.find((e) => e.metaInfo.contractAddress.toLowerCase() === resolved.address!.toLowerCase()) : undefined;
    const bySym = byAddr ?? variants.map((v) => board.find((e) => e.metaInfo.symbol.toUpperCase() === v)).find(Boolean);
    if (bySym) return { entry: bySym, chain, max };
  }
  return null;
}

function matchTopic(topics: TopicRushItem[], query: string): TopicRushItem | null {
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3);
  if (words.length === 0) return null;
  let best: { t: TopicRushItem; score: number } | null = null;
  for (const t of topics) {
    const hay = `${t.name?.topicNameEn ?? ""} ${(t.topicTags ?? []).join(" ")} ${t.aiSummary?.aiSummaryEn ?? ""}`.toLowerCase();
    const score = words.filter((w) => hay.includes(w)).length;
    if (score > 0 && (!best || score > best.score)) best = { t, score };
  }
  return best?.t ?? null;
}

export async function attentionBinance(resolved: Resolved, budget: BudgetGuard): Promise<Attention | null> {
  if (resolved.type === "token") {
    const hit = await findOnBoards(resolved, budget);
    if (!hit) return null;
    const info = hit.entry.socialHypeInfo ?? {};
    const { trend } = trendOf(hit.entry);
    return {
      hotness: hotness(hit.entry, hit.max),
      trend,
      mentions_24h: info.socialHype ?? null,
      sentiment: null, // the board reports a label, not ratios — never invent the split
      top_kols: [],
      sentiment_label: info.sentiment ?? null,
      summary: info.socialSummaryDetail ?? info.socialSummaryBrief ?? null,
      kol_count: info.kolCount ?? null,
      source: "binance-web3:social-hype",
    };
  }

  // Narrative: is this story one of the AI-detected hot topics right now?
  const topics = (await Promise.all(["56", "CT_501"].map((c) => topicRush(c, budget)))).flatMap((t) => t ?? []);
  const topic = matchTopic(topics, resolved.name);
  if (!topic) return null;
  const inflow = Number(topic.topicNetInflow ?? 0);
  const inflow1h = Number(topic.topicNetInflow1h ?? 0);
  return {
    hotness: null,
    trend: inflow1h > 0 ? "rising" : inflow1h < 0 ? "falling" : "flat",
    mentions_24h: null,
    sentiment: null,
    top_kols: [],
    sentiment_label: null,
    summary: `${topic.aiSummary?.aiSummaryEn ?? ""}${topic.tokenList?.length ? ` Tokens riding it: ${topic.tokenList.slice(0, 4).map((t) => t.symbol).join(", ")}.` : ""}${Number.isFinite(inflow) && inflow !== 0 ? ` Net inflow $${Math.round(inflow).toLocaleString()}.` : ""}`.trim() || null,
    kol_count: null,
    topic: topic.name?.topicNameEn ?? null,
    source: "binance-web3:topic-rush",
  };
}
