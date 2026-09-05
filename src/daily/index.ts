import type { DailyVerdict } from "../types.js";
import { BudgetGuard } from "../pipeline/budget.js";
import { isCliEntry } from "../fixtures.js";
import { runDailyBinance } from "./binance.js";

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

/** Daily alpha: research the day's strongest signals into ranked, cited picks. */
export async function runDaily(budget: BudgetGuard, readId?: string): Promise<Omit<DailyVerdict, "card_url" | "card_pending">> {
  return runDailyBinance(budget, readId);
}

if (isCliEntry(import.meta.url)) {
  const budget = new BudgetGuard();
  const out = await runDaily(budget);
  console.log(JSON.stringify(out, null, 2));
  console.log(`cost: $${budget.total().toFixed(5)}`);
}
