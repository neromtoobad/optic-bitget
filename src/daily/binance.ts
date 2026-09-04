import type { DailyVerdict, DailyTip } from "../types.js";
import { TIPS_SCHEMA } from "./index.js";
import { pmList, pmUrl, pmYesOutcome, socialHype, topicRush, smartMoneyInflow, memeRush, num, type PmTopic, type PmMarket } from "../lib/binance/web3.js";
import { researchSubject } from "../lenses/research.js";
import { structuredCall } from "../lib/anthropic.js";
import { lintVerdictStrings } from "../lint.js";
import type { BudgetGuard } from "../pipeline/budget.js";

// DAILY ALPHA (Binance edition) — today's picks from three Binance desks:
// Binance Wallet prediction markets (BNB Chain outcome markets — marquee fixtures,
// confident calls, markets ending soon), Binance Web3 momentum (social-hype
// accelerators, AI-detected narratives, smart-money inflow, fresh launches) and,
// honestly, no supply desk — the Binance kit carries no unlock calendar.

const SYSTEM = `You are OPTIC's daily alpha desk on Binance. You produce today's picks from live Binance data across desks, and you are DECISIVE — you name favourites and standouts and justify them. You are a sharp analyst giving a reasoned read, not a neutral data feed.
- PREDICTION: Binance Wallet prediction markets (outcome tokens on BNB Chain) with the priced probability, total volume, liquidity and end time, plus (for the top pick) a WEB RESEARCH brief with real-world context — form, injuries, roster news, catalysts. Combine the odds AND the research into a decisive read: name the favourite, and flag where research adds nuance.
- MEME MOMENTUM: tokens whose social hype is accelerating (accel_x vs earlier in the day), AI-detected hot narratives with net inflow and the tokens riding them, tokens receiving smart-money net inflow, and fresh launches with real activity. Be decisive about which token has the CLEANEST SETUP — deepest liquidity, lowest concentration, accelerating attention, smart money present — as OPTIC's strongest-setup call.
- SUPPLY RISK: no unlock calendar is available on this desk — do NOT invent supply events; leave that category empty.

Rules:
- BE DECISIVE. State your favourite/standout in each area and WHY. Lead the verdict_line and top_call with your single highest-conviction pick.
- Ground every call in the input's concrete numbers + research. Never invent a number or a fact not in the input.
- confidence = signal strength (volume/conviction/corroboration), explicitly NOT a predicted win rate. Never claim or imply an accuracy percentage or a profit guarantee.
- The coin desk is DILIGENCE framing: "cleanest setup / strongest fundamentals / lowest risk flags". NEVER a trade instruction or a hold/buy recommendation on a token.
- BANNED words: buy, sell, long, short, ape, moon, and action verbs like enter, exit, play, fade, accumulate, bet. (Use "the pick", "the favourite", "the value", "the standout", "the strongest setup".)
- A thin or empty desk is fine — do not manufacture picks.`;

const SHORT_UPDOWN = /updown-(5|15)m|up-or-down-.*-(am|pm)-et$|\b(5|15)m\b|-1h\b|up or down - .*\b\d{1,2}(:\d{2})?\s?(am|pm)\b/i;
const isFixture = (t: PmTopic) => / vs\.? | v\. /i.test(t.title) || (t.marketVariant ?? "").startsWith("SPORTS_MATCH") || (t.marketVariant ?? "") === "SPORTS_TEAM_MATCH";

interface Flat {
  t: PmTopic;
  m: PmMarket;
  yes: number;
  outcome: string;
  volume: number;
}

function flatten(topics: PmTopic[]): Flat[] {
  const out: Flat[] = [];
  for (const t of topics) {
    if (SHORT_UPDOWN.test(`${t.slug} ${t.title}`)) continue;
    if ((t.status ?? "") === "RESOLVED" || (t.endDate && t.endDate < Date.now())) continue;
    for (const m of t.markets ?? []) {
      if ((m.tradingStatus ?? "OPEN") !== "OPEN" || SHORT_UPDOWN.test(`${m.title} ${m.question ?? ""}`)) continue;
      const yes = pmYesOutcome(m);
      if (!yes) continue;
      out.push({ t, m, yes: yes.price, outcome: yes.name, volume: m.tradeVolume ?? 0 });
    }
  }
  return out;
}

export async function runDailyBinance(budget: BudgetGuard, _readId?: string): Promise<Omit<DailyVerdict, "card_url" | "card_pending">> {
  void _readId; // TODO(track): resolve Binance picks via pmDetail outcomes[].winner, then log them
  const [topics, hypeBsc, hypeSol, narrBsc, narrSol, inflow, fresh] = await Promise.all([
    pmList({ sortBy: "VOLUME", orderBy: "DESC", limit: 40 }, budget),
    socialHype("56", 1, budget),
    socialHype("CT_501", 1, budget),
    topicRush("56", budget),
    topicRush("CT_501", budget),
    smartMoneyInflow("56", 10, budget),
    memeRush("56", 10, 20, budget),
  ]);

  // Prediction desk.
  const flat = flatten(topics ?? []);
  const byMatchup = flat.filter((f) => isFixture(f.t) && f.volume > 3_000).sort((a, b) => b.volume - a.volume).slice(0, 4);
  const byConviction = flat
    .filter((f) => f.volume > 5_000 && Math.max(f.yes, 1 - f.yes) >= 0.6 && Math.max(f.yes, 1 - f.yes) <= 0.95)
    .sort((a, b) => Math.max(b.yes, 1 - b.yes) * b.volume - Math.max(a.yes, 1 - a.yes) * a.volume)
    .slice(0, 5);
  const soon = Date.now() + 48 * 3_600_000;
  const endingSoon = flat.filter((f) => f.volume > 5_000 && f.t.endDate && f.t.endDate < soon).sort((a, b) => (a.t.endDate ?? 0) - (b.t.endDate ?? 0)).slice(0, 3);
  const used = [...new Map([...byMatchup, ...byConviction, ...endingSoon].map((f) => [`${f.t.slug}#${f.m.marketId}`, f])).values()];
  const predictionInput = used.map((f) => ({
    market: f.m.question ?? f.m.title,
    event: f.t.title,
    outcome: f.outcome,
    yes_pct: Math.round(f.yes * 1000) / 10,
    volume_usd: Math.round(f.volume),
    liquidity_usd: Math.round(f.m.liquidity ?? 0),
    participants: f.t.participantCount ?? null,
    ends_at: f.t.endDate ? new Date(f.t.endDate).toISOString() : null,
    category: f.t.l1Categories?.[0] ?? null,
    url: pmUrl(f.t.slug, (f.t.topicType ?? "") === "GROUPED"),
  }));

  // Momentum desk.
  const accel = (e: { socialHypeInfo?: { socialHypeSerialChart?: Array<{ socialHype: number }> } }): number | null => {
    const s = e.socialHypeInfo?.socialHypeSerialChart ?? [];
    if (s.length < 6) return null;
    const k = Math.min(6, Math.floor(s.length / 2));
    const avg = (xs: typeof s) => xs.reduce((a, x) => a + (x.socialHype ?? 0), 0) / xs.length;
    const a = avg(s.slice(0, k));
    return a > 0 ? Math.round((avg(s.slice(-k)) / a) * 10) / 10 : null;
  };
  const rising = [...(hypeBsc ?? []), ...(hypeSol ?? [])]
    .map((e) => ({ symbol: e.metaInfo.symbol, hype_24h: e.socialHypeInfo?.socialHype ?? null, accel_x: accel(e), sentiment: e.socialHypeInfo?.sentiment ?? null, summary: (e.socialHypeInfo?.socialSummaryBrief ?? "").slice(0, 120) }))
    .filter((r) => (r.accel_x ?? 0) >= 1.3)
    .sort((a, b) => (b.accel_x ?? 0) - (a.accel_x ?? 0))
    .slice(0, 6);
  const narratives = [...(narrBsc ?? []), ...(narrSol ?? [])]
    .map((t) => ({ topic: t.name?.topicNameEn ?? "?", net_inflow_usd: Math.round(Number(t.topicNetInflow ?? 0)), net_inflow_1h_usd: Math.round(Number(t.topicNetInflow1h ?? 0)), tokens: (t.tokenList ?? []).slice(0, 3).map((k) => k.symbol), summary: (t.aiSummary?.aiSummaryEn ?? "").slice(0, 160) }))
    .sort((a, b) => b.net_inflow_1h_usd - a.net_inflow_1h_usd || b.net_inflow_usd - a.net_inflow_usd)
    .slice(0, 5);
  const smartInflow = (inflow ?? []).slice(0, 6).map((t) => ({
    symbol: t.tokenName,
    inflow_usd: Math.round(t.inflow ?? 0),
    smart_traders: t.traders ?? null,
    market_cap_usd: num(t.marketCap),
    liquidity_usd: num(t.liquidity),
    top10_pct: num(t.holdersTop10Percent),
    chg_24h: num(t.priceChangeRate),
    risk_level: t.tokenRiskLevel ?? null,
  }));
  const freshLaunches = (fresh ?? [])
    .filter((t) => (t.holders ?? 0) >= 50 || (num(t.volume) ?? 0) > 5_000)
    .slice(0, 4)
    .map((t) => ({ symbol: t.symbol, market_cap_usd: num(t.marketCap), holders: t.holders ?? null, volume_usd: num(t.volume), dev_pct: num(t.holdersDevPercent), top10_pct: num(t.holdersTop10Percent) }));

  // Research the top researchable pick: a fixture first, else the top conviction call.
  const band = (f: Flat) => Math.max(f.yes, 1 - f.yes) >= 0.5 && Math.max(f.yes, 1 - f.yes) <= 0.92;
  const target = used.find((f) => isFixture(f.t) && band(f)) ?? used.find((f) => isFixture(f.t)) ?? used.find(band) ?? used[0];
  const webResearch = target ? await researchSubject(isFixture(target.t) ? target.t.title : (target.m.question ?? target.t.title).replace(/^will\s+/i, "").replace(/\?$/, ""), budget) : null;

  const input = {
    prediction_markets: predictionInput,
    top_pick_web_research: webResearch && target ? { subject: target.t.title, brief: webResearch.brief } : null,
    meme_momentum: { rising, hot_narratives: narratives, smart_money_inflow: smartInflow, fresh_launches: freshLaunches },
    supply_events: [],
    scanned: { markets: flat.length, rising: rising.length, narratives: narratives.length, smart_money: smartInflow.length, fresh: freshLaunches.length, unlocks: 0 },
  };

  let feedback = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = await structuredCall<{ top_call: DailyVerdict["top_call"]; tips: DailyTip[]; research_note: string; verdict_line: string }>({
      label: attempt === 0 ? "daily_tips" : "daily_tips_retry",
      system: SYSTEM,
      user: JSON.stringify(input) + feedback,
      schema: TIPS_SCHEMA as unknown as Record<string, unknown>,
      budget,
      maxTokens: 1400,
    });
    const strings = [out.verdict_line, out.top_call.headline, out.top_call.reason, ...out.tips.flatMap((t) => [t.headline, t.research])];
    const lint = lintVerdictStrings(strings);
    if (lint.ok) {
      return {
        query: "daily",
        resolved: { type: "daily", name: "daily alpha" },
        top_call: out.top_call,
        tips: out.tips.filter((t) => t.category !== "supply_risk"),
        research: webResearch,
        research_note: out.research_note,
        verdict_line: out.verdict_line,
        generated_at: new Date().toISOString(),
      };
    }
    feedback = `\n\nYour previous output failed the language lint on: ${JSON.stringify(lint.violations.map((v) => v.word))}. Rewrite those without the banned words.`;
  }
  throw new Error("daily tips failed banned-word lint after retry");
}
