import type { ScanVerdict } from "../types.js";
import { socialHype, topicRush, memeRush, smartMoneyInflow, num, type SocialHypeEntry } from "../lib/binance/web3.js";
import { structuredCall } from "../lib/anthropic.js";
import { lintVerdictStrings } from "../lint.js";
import type { BudgetGuard } from "../pipeline/budget.js";

// SCAN (Binance edition) — discovery over the Binance Web3 market: who is
// accelerating on the social-hype boards, which AI-detected narratives are
// pulling inflow right now, what just launched with real activity, and where
// smart money's net inflow is going. Same ScanVerdict shape as the OKX scan.

const SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    highlights: {
      type: "array",
      items: { type: "string" },
      description: "3-5 short observations: which tokens' social hype is accelerating BEFORE being crowded, which hot narratives are pulling inflow, notable fresh launches with real activity, where smart money inflow concentrates. Each cites a number from the input.",
    },
    verdict_line: { type: "string", description: "One shareable line (<=140 chars) naming where attention is moving earliest." },
  },
  required: ["highlights", "verdict_line"],
  additionalProperties: false,
} as const;

const SYSTEM = `You are OPTIC's market scanner on Binance Web3. Input: (a) social-hype leaders with an acceleration factor (recent hype vs earlier in the day — accel_x > 1.5 means chatter is spiking NOW) and a sentiment label + AI summary, (b) AI-detected hot narratives (topics) with net inflow and the tokens riding them, (c) fresh launchpad tokens with real activity, (d) tokens receiving the most smart-money net inflow.
Rules: observational language only (rising, accelerating, crowded, asleep). NEVER instructions — banned: buy, sell, long, short, ape, moon, and action verbs like enter, exit, play, fade. Never invent data; cite numbers from the input. Early ≠ good: crowded leaders (BTC/ETH always lead in absolute hype) matter less than unusual accelerators and fresh narratives.`;

function accel(e: SocialHypeEntry): number | null {
  const s = e.socialHypeInfo?.socialHypeSerialChart ?? [];
  if (s.length < 6) return null;
  const k = Math.min(6, Math.floor(s.length / 2));
  const avg = (xs: typeof s) => xs.reduce((a, x) => a + (x.socialHype ?? 0), 0) / xs.length;
  const a = avg(s.slice(0, k));
  const b = avg(s.slice(-k));
  return a > 0 ? Math.round((b / a) * 10) / 10 : null;
}

export async function runScanBinance(budget: BudgetGuard): Promise<Omit<ScanVerdict, "card_url" | "card_pending">> {
  const [hypeBsc, hypeSol, topicsBsc, topicsSol, freshBsc, freshSol, inflow] = await Promise.all([
    socialHype("56", 1, budget),
    socialHype("CT_501", 1, budget),
    topicRush("56", budget),
    topicRush("CT_501", budget),
    memeRush("56", 10, 20, budget),
    memeRush("CT_501", 10, 20, budget),
    smartMoneyInflow("56", 10, budget),
  ]);

  const rising = [...(hypeBsc ?? []), ...(hypeSol ?? [])]
    .map((e) => {
      const s = e.socialHypeInfo?.socialHypeSerialChart ?? [];
      return {
        symbol: e.metaInfo.symbol,
        mentions_1h: s.length ? Math.round(s[s.length - 1]?.socialHype ?? 0) : null,
        mentions_24h: e.socialHypeInfo?.socialHype ?? null,
        accel_x: accel(e),
        sentiment_label: e.socialHypeInfo?.sentiment ?? null,
        bullish_ratio: null,
      };
    })
    .sort((a, b) => (b.accel_x ?? 0) - (a.accel_x ?? 0) || (b.mentions_24h ?? 0) - (a.mentions_24h ?? 0))
    .slice(0, 10);

  const freshTrenches = [...(freshBsc ?? []), ...(freshSol ?? [])]
    .filter((t) => (t.holders ?? 0) >= 50 || (t.count ?? 0) >= 50 || (num(t.volume) ?? 0) > 5_000)
    .map((t) => ({ symbol: t.symbol ?? "?", address: t.contractAddress ?? null, market_cap_usd: num(t.marketCap), volume_1h_usd: num(t.volume) }))
    .sort((a, b) => (b.volume_1h_usd ?? 0) - (a.volume_1h_usd ?? 0))
    .slice(0, 5);

  const narratives = [...(topicsBsc ?? []), ...(topicsSol ?? [])]
    .map((t) => ({
      topic: t.name?.topicNameEn ?? "?",
      tags: t.topicTags ?? [],
      net_inflow_usd: Math.round(Number(t.topicNetInflow ?? 0)),
      net_inflow_1h_usd: Math.round(Number(t.topicNetInflow1h ?? 0)),
      tokens: (t.tokenList ?? []).slice(0, 3).map((k) => k.symbol),
      summary: (t.aiSummary?.aiSummaryEn ?? "").slice(0, 200),
    }))
    .sort((a, b) => b.net_inflow_1h_usd - a.net_inflow_1h_usd || b.net_inflow_usd - a.net_inflow_usd)
    .slice(0, 6);

  const smartInflow = (inflow ?? []).slice(0, 6).map((t) => ({
    symbol: t.tokenName,
    inflow_usd: Math.round(t.inflow ?? 0),
    smart_traders: t.traders ?? null,
    market_cap_usd: num(t.marketCap),
    chg_24h: num(t.priceChangeRate),
  }));

  const scan = { rising, fresh_trenches: freshTrenches, unlock_calendar: [] as ScanVerdict["scan"]["unlock_calendar"] };
  const input = { ...scan, hot_narratives: narratives, smart_money_inflow: smartInflow };

  let feedback = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = await structuredCall<{ highlights: string[]; verdict_line: string }>({
      label: attempt === 0 ? "scan_summary" : "scan_summary_retry",
      system: SYSTEM,
      user: JSON.stringify(input) + feedback,
      schema: SUMMARY_SCHEMA as unknown as Record<string, unknown>,
      budget,
      maxTokens: 600,
    });
    const lint = lintVerdictStrings([out.verdict_line, ...out.highlights]);
    if (lint.ok) {
      return {
        query: "scan",
        resolved: { type: "scan", name: "market scan" },
        scan,
        highlights: out.highlights,
        verdict_line: out.verdict_line,
        generated_at: new Date().toISOString(),
      };
    }
    feedback = `\n\nYour previous output failed the language lint on: ${JSON.stringify(lint.violations.map((v) => v.word))}. Rewrite without those words.`;
  }
  throw new Error("scan summary failed banned-word lint after retry");
}
