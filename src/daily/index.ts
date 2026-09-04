import type { DailyVerdict, DailyTip } from "../types.js";
import { trendingMarkets } from "../lib/polymarket.js";
import { sentimentRanking, memeTokenList, num } from "../lib/okx.js";
import { unlockCalendar } from "../lenses/unlocks.js";
import { structuredCall } from "../lib/anthropic.js";
import { lintVerdictStrings } from "../lint.js";
import { BudgetGuard } from "../pipeline/budget.js";
import { isCliEntry } from "../fixtures.js";
import { config } from "../config.js";
import { runDailyCEX } from "./cex.js";

export const TIPS_SCHEMA = {
  type: "object",
  properties: {
    top_call: {
      type: "object",
      description: "OPTIC's single most decisive call of the day — the one pick you have the most conviction in, stated as a clear position.",
      properties: {
        category: { type: "string", enum: ["prediction", "meme_momentum", "supply_risk"] },
        headline: { type: "string", description: "The decisive call in plain words — name the favourite / the standout. e.g. 'France is the pick to win the World Cup' or 'X has the cleanest setup of today's movers'." },
        reason: { type: "string", description: "Why — the market data AND the web research combined into a clear justification. Cite specifics (odds, form, injuries, liquidity, holder concentration, unlock timing)." },
      },
      required: ["category", "headline", "reason"],
      additionalProperties: false,
    },
    tips: {
      type: "array",
      items: {
        type: "object",
        properties: {
          category: { type: "string", enum: ["prediction", "meme_momentum", "supply_risk"] },
          headline: { type: "string", description: "A DECISIVE pick — name the favourite / the strongest-setup token / the key risk, not a neutral summary. e.g. 'England is the value at 14.6%', 'X token has the cleanest onchain setup', 'PUMP unlock is the risk to respect'." },
          research: { type: "string", description: "The evidence: concrete numbers (odds, 24h move, volume, acceleration, liquidity, holder %, unlock size/date) plus any researched context." },
          confidence: {
            type: "string",
            enum: ["high", "medium", "watch"],
            description: "Strength of the SIGNAL (volume + conviction + corroboration), NOT a predicted win rate. high = decisive odds on heavy volume or a large corroborated move; watch = early/thin signal.",
          },
          url: { type: "string", description: "Polymarket URL if the tip is a prediction market; else empty string." },
        },
        required: ["category", "headline", "research", "confidence", "url"],
        additionalProperties: false,
      },
    },
    research_note: { type: "string", description: "One line on what was scanned (counts of markets/tokens/unlocks reviewed)." },
    verdict_line: { type: "string", description: "One shareable headline (<=140 chars) stating today's single strongest call decisively." },
  },
  required: ["top_call", "tips", "research_note", "verdict_line"],
  additionalProperties: false,
} as const;

const SYSTEM = `You are OPTIC's daily alpha desk. You produce today's picks from live data across three desks, and you are DECISIVE — you name favourites and standouts and justify them. You are a sharp analyst giving a reasoned read, not a neutral data feed.
- PREDICTION: trending outcome markets with yes-price, 24h odds move, and volume, plus (for the top pick) a WEB RESEARCH brief with real-world context — form, injuries, roster news, catalysts. Combine the odds AND the research into a decisive read: name the favourite, and flag where research adds nuance (e.g. "market favours Spain but they're missing two starters — Portugal at 22.5% is the value").
- MEME MOMENTUM: tokens whose social mention rate is accelerating vs baseline, and fresh launches with real volume. Be decisive about which token has the CLEANEST SETUP — deepest liquidity, lowest dev/holder concentration, no near-term unlock, accelerating attention — as OPTIC's strongest-setup call.
- SUPPLY RISK: scheduled unlocks/vesting — name the token whose unlock is the biggest risk to respect.

Rules:
- BE DECISIVE. State your favourite/standout in each area and WHY. "Market favours X at N% and the research backs it because [form/injury]" beats "X is at N%". Lead the verdict_line and top_call with your single highest-conviction pick.
- Ground every call in the input's concrete numbers + research. Never invent a number or a fact not in the input.
- confidence = signal strength (volume/conviction/corroboration), explicitly NOT a predicted win rate. Never claim or imply an accuracy percentage or a profit guarantee.
- The coin/trading desk is DILIGENCE framing: "cleanest setup / strongest fundamentals / lowest risk flags", decisive about which token stands out and why. NEVER a trade instruction or a hold/buy recommendation on a token.
- BANNED words: buy, sell, long, short, ape, moon, and action verbs like enter, exit, play, fade, accumulate, bet. (Being decisive does NOT require these — use "the pick", "the favourite", "the value", "the standout", "the strongest setup".)
- A thin or empty desk is fine — do not manufacture picks.`;

import { logPicks } from "../track/picks.js";
import { researchSubject } from "../lenses/research.js";

// A specific fixture (a real upcoming match/event) is worth researching — form,
// injuries, catalysts move it. A tournament outright ("win the World Cup") is not.
const isFixture = (question: string, eventTitle: string): boolean =>
  / vs\.? | v\. |on 20\d\d-|\bat\b/i.test(`${eventTitle} ${question}`) || / vs\.? /i.test(eventTitle);

/** Build a searchable subject, preferring a matchup event title over the bare market question. */
function researchSubjectFor(question: string, eventTitle: string): string {
  if (/ vs\.? | v\. /i.test(eventTitle)) return eventTitle.trim();
  return question.replace(/^will\s+/i, "").replace(/\?$/, "").trim();
}

/** Daily alpha: research the day's strongest signals into ranked, cited picks. */
export async function runDaily(budget: BudgetGuard, readId?: string): Promise<Omit<DailyVerdict, "card_url" | "card_pending">> {
  if (config.exchange === "cex") return runDailyCEX(budget, readId);
  const [trending, rank1h, rank24h, fresh, unlocks] = await Promise.all([
    trendingMarkets(40),
    sentimentRanking("1", 20, budget),
    sentimentRanking("3", 20, budget),
    memeTokenList("NEW", 10, budget),
    unlockCalendar(budget),
  ]);

  // Prediction desk: today's marquee matchups (research targets) + confident calls
  // + top movers. Matchups first — a high-volume near-term fixture is the most
  // valuable thing to give a research-backed read on, even at coin-flip odds.
  const mkts = trending ?? [];
  const byMatchup = [...mkts]
    .filter((m) => m.volume_24h > 300_000 && isFixture(m.question, m.eventTitle))
    .sort((a, b) => b.volume_24h - a.volume_24h)
    .slice(0, 4);
  const byConviction = [...mkts]
    .filter((m) => m.volume_24h > 100_000 && m.conviction > 0.25)
    .sort((a, b) => b.conviction * b.volume_24h - a.conviction * a.volume_24h)
    .slice(0, 5);
  const byMomentum = [...mkts]
    .filter((m) => m.volume_24h > 100_000 && m.momentum >= 0.05)
    .sort((a, b) => b.momentum - a.momentum)
    .slice(0, 4);
  const usedMarkets = [...new Map([...byMatchup, ...byConviction, ...byMomentum].map((m) => [m.slug, m])).values()];
  const predictionInput = usedMarkets.map((m) => ({
    market: m.question,
    event: m.eventTitle,
    yes_pct: Math.round(m.yes_price * 1000) / 10,
    move_24h_pts: m.chg_24h === null ? null : Math.round(m.chg_24h * 1000) / 10,
    volume_24h_usd: m.volume_24h,
    url: `https://polymarket.com/market/${m.slug}`,
  }));

  // Log the surfaced prediction markets to the track record — scored when they
  // resolve on Polymarket. Honest "accuracy" accrues here, unfaked.
  if (readId) {
    logPicks(
      readId,
      usedMarkets.map((m) => ({
        category: "prediction" as const,
        subject: m.eventTitle || m.question,
        market_question: m.question,
        market_slug: m.slug,
        yes_price: m.yes_price,
      }))
    );
  }

  // Meme momentum desk: 1h-vs-24h mention acceleration.
  const baseline = new Map<string, number>();
  for (const d of rank24h?.details ?? []) baseline.set(d.tokenSymbol, num(d.mentionCount) ?? 0);
  const rising = (rank1h?.details ?? [])
    .map((d) => {
      const m1h = num(d.mentionCount);
      const m24h = baseline.get(d.tokenSymbol) ?? null;
      const accel = m1h !== null && m24h && m24h > 0 ? Math.round((m1h / (m24h / 24)) * 10) / 10 : null;
      return { symbol: d.tokenSymbol, mentions_1h: m1h, accel_x: accel, sentiment: d.sentiment?.label ?? null };
    })
    .filter((r) => (r.accel_x ?? 0) >= 2)
    .sort((a, b) => (b.accel_x ?? 0) - (a.accel_x ?? 0))
    .slice(0, 6);
  const freshTrenches = (fresh ?? [])
    .map((t) => ({ symbol: t.symbol ?? "?", volume_1h_usd: num(t.market?.volumeUsd1h), market_cap_usd: num(t.market?.marketCapUsd) }))
    .filter((t) => (t.volume_1h_usd ?? 0) > 2_000)
    .slice(0, 4);

  // Research the TOP researchable pick. Prefer a SPECIFIC fixture (today's actual
  // match — form/injuries move it) over a vague tournament outright, within a
  // meaningful implied band. That's where web research adds the most value.
  const band = (m: (typeof usedMarkets)[number]) => {
    const implied = Math.max(m.yes_price, 1 - m.yes_price);
    return implied >= 0.5 && implied <= 0.92;
  };
  const researchTarget =
    usedMarkets.find((m) => isFixture(m.question, m.eventTitle) && band(m)) ??
    usedMarkets.find((m) => isFixture(m.question, m.eventTitle)) ??
    usedMarkets.find(band) ??
    usedMarkets[0];
  const webResearch = researchTarget
    ? await researchSubject(researchSubjectFor(researchTarget.question, researchTarget.eventTitle), budget)
    : null;

  const researchInput = {
    prediction_markets: predictionInput,
    top_pick_web_research: webResearch
      ? { subject: researchTarget!.question, brief: webResearch.brief }
      : null,
    meme_momentum: { rising, fresh_launches: freshTrenches },
    supply_events: unlocks,
    scanned: { markets: mkts.length, rising: rising.length, fresh: freshTrenches.length, unlocks: unlocks.length },
  };

  let feedback = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = await structuredCall<{
      top_call: DailyVerdict["top_call"];
      tips: DailyTip[];
      research_note: string;
      verdict_line: string;
    }>({
      label: attempt === 0 ? "daily_tips" : "daily_tips_retry",
      system: SYSTEM,
      user: JSON.stringify(researchInput) + feedback,
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
        tips: out.tips,
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

if (isCliEntry(import.meta.url)) {
  const budget = new BudgetGuard();
  const out = await runDaily(budget);
  console.log(JSON.stringify(out, null, 2));
  console.log(`cost: $${budget.total().toFixed(5)}`);
}
