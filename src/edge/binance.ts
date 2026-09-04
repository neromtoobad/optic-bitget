import type { EdgeVerdict } from "../types.js";
import { EDGE_SCHEMA, EDGE_SYSTEM } from "./index.js";
import { pmList, pmUrl, pmYesOutcome, type PmTopic } from "../lib/binance/web3.js";
import { researchSubject } from "../lenses/research.js";
import { structuredCall } from "../lib/anthropic.js";
import { lintVerdictStrings } from "../lint.js";
import type { BudgetGuard } from "../pipeline/budget.js";

// EDGE (Binance edition) — the mispricing radar over Binance Wallet prediction
// markets: research the day's competitive, researchable markets (fixtures,
// macro decisions, elections) and rank where the priced probability looks soft
// or rich against the facts. Conservative by design — the market is usually right.

const SHORT_UPDOWN = /updown-(5|15)m|up-or-down-.*-(am|pm)-et$|\b(5|15)m\b|-1h\b|up or down - .*\b\d{1,2}(:\d{2})?\s?(am|pm)\b/i;
const isFixture = (t: PmTopic) => / vs\.? | v\. /i.test(t.title) || (t.marketVariant ?? "").startsWith("SPORTS_MATCH") || (t.marketVariant ?? "") === "SPORTS_TEAM_MATCH";
const researchable = (t: PmTopic) => isFixture(t) || (t.l1Categories ?? []).some((c) => ["economy", "politics", "sports", "tech", "finance"].includes(c));

export async function runEdgeBinance(budget: BudgetGuard, _readId?: string): Promise<Omit<EdgeVerdict, "card_url" | "card_pending">> {
  void _readId; // TODO(track): log Binance picks once the resolver reads pmDetail outcomes[].winner
  const topics = (await pmList({ sortBy: "VOLUME", orderBy: "DESC", limit: 40 }, budget)) ?? [];

  const candidates = topics
    .filter((t) => !SHORT_UPDOWN.test(`${t.slug} ${t.title}`) && (t.status ?? "") !== "RESOLVED" && (!t.endDate || t.endDate > Date.now()) && researchable(t))
    .flatMap((t) => (t.markets ?? []).filter((m) => (m.tradingStatus ?? "OPEN") === "OPEN" && !SHORT_UPDOWN.test(`${m.title} ${m.question ?? ""}`)).map((m) => ({ t, m, yes: pmYesOutcome(m)?.price ?? 0, volume: m.tradeVolume ?? 0 })))
    .filter(({ yes, volume }) => volume > 3_000 && Math.max(yes, 1 - yes) >= 0.5 && Math.max(yes, 1 - yes) <= 0.9)
    .sort((a, b) => b.volume - a.volume)
    // one market per topic — research the topic once
    .filter((c, i, arr) => arr.findIndex((x) => x.t.slug === c.t.slug) === i)
    .slice(0, 3);

  const researched = await Promise.all(
    candidates.map(async ({ t, m, yes, volume }) => {
      const subject = isFixture(t) ? t.title : (m.question ?? t.title).replace(/^will\s+/i, "").replace(/\?$/, "");
      const r = await researchSubject(subject, budget);
      return {
        market: m.question ?? m.title,
        event: t.title,
        outcome: pmYesOutcome(m)?.name ?? "Yes",
        implied_pct: Math.round(yes * 1000) / 10,
        volume_usd: Math.round(volume),
        liquidity_usd: Math.round(m.liquidity ?? 0),
        ends_at: t.endDate ? new Date(t.endDate).toISOString() : null,
        url: pmUrl(t.slug, (t.topicType ?? "") === "GROUPED"),
        research: r?.brief ?? null,
      };
    })
  );

  const withResearch = researched.filter((r) => r.research);
  let feedback = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = await structuredCall<Omit<EdgeVerdict, "query" | "resolved" | "generated_at" | "card_url" | "card_pending">>({
      label: attempt === 0 ? "edge" : "edge_retry",
      system: EDGE_SYSTEM,
      user: JSON.stringify({ venue: "Binance Wallet prediction markets (BNB Chain)", markets: withResearch, scanned: topics.length, researched: withResearch.length }) + feedback,
      schema: EDGE_SCHEMA as unknown as Record<string, unknown>,
      budget,
      maxTokens: 1400,
    });
    const strings = [out.verdict_line, ...out.edges.flatMap((e) => [e.read, e.why])];
    const lint = lintVerdictStrings(strings);
    if (lint.ok) {
      return {
        query: "edge",
        resolved: { type: "edge", name: "edge radar" },
        edges: out.edges.sort((a, b) => b.edge_score - a.edge_score),
        verdict_line: out.verdict_line,
        research_note: out.research_note,
        generated_at: new Date().toISOString(),
      };
    }
    feedback = `\n\nPrevious output failed the language lint on: ${JSON.stringify(lint.violations.map((v) => v.word))}. Rewrite without those.`;
  }
  throw new Error("edge output failed banned-word lint after retry");
}
