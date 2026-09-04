import type { ScanVerdict } from "../types.js";
import { sentimentRanking, memeTokenList, num } from "../lib/okx.js";
import { unlockCalendar } from "../lenses/unlocks.js";
import { structuredCall } from "../lib/anthropic.js";
import { lintVerdictStrings } from "../lint.js";
import { BudgetGuard } from "../pipeline/budget.js";
import { isCliEntry } from "../fixtures.js";
import { config } from "../config.js";
import { runScanBinance } from "./binance.js";

const SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    highlights: {
      type: "array",
      items: { type: "string" },
      description: "3-5 short observations: which narratives are accelerating BEFORE being crowded, notable fresh trenches launches, scheduled supply events. Each cites a number from the input.",
    },
    verdict_line: {
      type: "string",
      description: "One shareable line (<=140 chars) naming where attention is moving earliest.",
    },
  },
  required: ["highlights", "verdict_line"],
  additionalProperties: false,
} as const;

const SYSTEM = `You are OPTIC's market scanner. Input: (a) social mention leaders for the last 1h and 24h with an acceleration factor (1h mention rate vs 24h baseline — accel_x > 2 means chatter is spiking NOW), (b) freshly created trenches tokens with real volume, (c) scheduled token unlock events from news.
Rules: observational language only (rising, accelerating, crowded, asleep, scheduled). NEVER instructions — banned: buy, sell, long, short, ape, moon, and action verbs like enter, exit, play, fade. Never invent data; cite numbers from the input. Early ≠ good: crowded leaders (BTC/ETH always lead in absolute mentions) matter less than unusual accelerators.`;

/** Discovery read: where is attention accelerating before it's crowded. */
export async function runScan(budget: BudgetGuard): Promise<Omit<ScanVerdict, "card_url" | "card_pending">> {
  if (config.exchange === "binance") return runScanBinance(budget);
  const [rank1h, rank24h, fresh, unlocks] = await Promise.all([
    sentimentRanking("1", 20, budget),
    sentimentRanking("3", 20, budget),
    memeTokenList("NEW", 10, budget),
    unlockCalendar(budget),
  ]);

  const baseline = new Map<string, number>();
  for (const d of rank24h?.details ?? []) {
    baseline.set(d.tokenSymbol, num(d.mentionCount) ?? 0);
  }

  const rising = (rank1h?.details ?? [])
    .map((d) => {
      const m1h = num(d.mentionCount);
      const m24h = baseline.get(d.tokenSymbol) ?? null;
      // acceleration: this hour's mentions vs the average hour of the last day
      const accel = m1h !== null && m24h !== null && m24h > 0 ? Math.round((m1h / (m24h / 24)) * 10) / 10 : null;
      return {
        symbol: d.tokenSymbol,
        mentions_1h: m1h,
        mentions_24h: m24h,
        accel_x: accel,
        sentiment_label: d.sentiment?.label ?? null,
        bullish_ratio: num(d.sentiment?.bullishRatio),
      };
    })
    .sort((a, b) => (b.accel_x ?? 0) - (a.accel_x ?? 0))
    .slice(0, 10);

  const freshTrenches = (fresh ?? [])
    .map((t) => ({
      symbol: t.symbol ?? "?",
      address: t.tokenAddress ?? null,
      market_cap_usd: num(t.market?.marketCapUsd),
      volume_1h_usd: num(t.market?.volumeUsd1h),
    }))
    .filter((t) => (t.volume_1h_usd ?? 0) > 1_000)
    .slice(0, 5);

  const scan = { rising, fresh_trenches: freshTrenches, unlock_calendar: unlocks };

  let feedback = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = await structuredCall<{ highlights: string[]; verdict_line: string }>({
      label: attempt === 0 ? "scan_summary" : "scan_summary_retry",
      system: SYSTEM,
      user: JSON.stringify(scan) + feedback,
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

if (isCliEntry(import.meta.url)) {
  const budget = new BudgetGuard();
  const out = await runScan(budget);
  console.log(JSON.stringify(out, null, 2));
  console.log(`cost: $${budget.total().toFixed(5)}`);
}
