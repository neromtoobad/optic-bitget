import type { EdgeVerdict } from "../types.js";
import { BudgetGuard } from "../pipeline/budget.js";
import { isCliEntry } from "../fixtures.js";
import { runEdgeBinance } from "./binance.js";

// EDGE ENGINE — the mispricing radar. Where does the RESEARCH diverge from the
// PRICE? For today's competitive markets, OPTIC pulls real-world research and
// ranks where the market's implied probability may be soft or rich given the
// facts. Honest: this flags divergence between price and research — it does NOT
// guarantee outcomes or beat the market. It's "worth a second look", scored.

const isFixture = (q: string, e: string) => / vs\.? | v\. |on 20\d\d-|\bat\b/i.test(`${e} ${q}`) || / vs\.? /i.test(e);

export const EDGE_SCHEMA = {
  type: "object",
  properties: {
    edges: {
      type: "array",
      items: {
        type: "object",
        properties: {
          market: { type: "string", description: "The market question." },
          market_price: { type: "string", description: "The current implied probability, e.g. '50.5% Spain to win'." },
          read: { type: "string", description: "OPTIC's edge read: does the research suggest the price is SOFT (outcome more likely than priced) or RICH (less likely)? Name the side and direction." },
          why: { type: "string", description: "The specific researched facts that create the gap (injuries, form, news) vs what the price implies." },
          edge_score: { type: "integer", description: "0-100: how large the gap between research and price looks. 0 = price matches research, 100 = stark mismatch. Be conservative — the market is usually right." },
          url: { type: "string" },
        },
        required: ["market", "market_price", "read", "why", "edge_score", "url"],
        additionalProperties: false,
      },
    },
    verdict_line: { type: "string", description: "One line (<=140 chars) naming the single biggest potential mispricing found today." },
    research_note: { type: "string", description: "One line on what was scanned." },
  },
  required: ["edges", "verdict_line", "research_note"],
  additionalProperties: false,
} as const;

export const EDGE_SYSTEM = `You are OPTIC's edge desk. Your ONE job: find where the market's price may be MISPRICED versus the real-world research. For each researched market you get the implied probability AND a web-research brief (form, injuries, news).

For each, judge: does the research support the price, or suggest the priced outcome is more likely (price SOFT) or less likely (price RICH) than the market says? Rank by the size of that gap (edge_score).

Rules:
- Be CONSERVATIVE and honest. The market is usually right — most edge_scores should be low (0-30). Only flag a real gap (50+) when the research clearly points the other way from the price (e.g. the favourite is missing two starters but is still priced as a strong favourite).
- Every 'why' cites specific researched facts. Never invent a fact or a number.
- This is analysis of a price-vs-research gap, NOT a guaranteed outcome or a profit claim. Never claim certainty or an accuracy rate.
- Observational language. BANNED words: buy, sell, long, short, ape, moon, enter, exit, play, fade, accumulate, bet. Use "the value looks", "the price looks soft/rich", "the read favours".
- If no market shows a real edge, say so — an honest "market looks efficient today" beats a manufactured edge.`;

export async function runEdge(budget: BudgetGuard, readId?: string): Promise<Omit<EdgeVerdict, "card_url" | "card_pending">> {
  return runEdgeBinance(budget, readId);
}

if (isCliEntry(import.meta.url)) {
  const budget = new BudgetGuard();
  const out = await runEdge(budget);
  console.log(JSON.stringify(out, null, 2));
  console.log(`cost: $${budget.total().toFixed(5)}`);
}
