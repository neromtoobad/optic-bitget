import type { Resolved } from "../types.js";
import { BudgetGuard } from "../pipeline/budget.js";
import { isCliEntry } from "../fixtures.js";
import { narrativeTimingBinance } from "./binance/timing.js";

// NARRATIVE TIMING — is this narrative EARLY (accelerating, fresh) or LATE
// (peaked, decaying)? In memes, timing is everything: the same token is a
// different story on day 1 vs day 10. Lifecycle stage from social hotness
// trajectory + onchain token age. Observational timing read, not advice.

export interface Timing {
  stage: "igniting" | "building" | "peaking" | "cooling" | "quiet";
  read: string; // one-line plain-language timing read
  age_hours: number | null;
  hotness: number | null;
  hotness_change_pct: number | null;
  engagement_change_pct: number | null;
}

export async function narrativeTiming(resolved: Resolved, budget: BudgetGuard): Promise<Timing | null> {
  return narrativeTimingBinance(resolved, budget);
}

if (isCliEntry(import.meta.url)) {
  const budget = new BudgetGuard();
  const name = process.argv.slice(2).join(" ") || "BTC";
  console.log(JSON.stringify(await narrativeTiming({ type: "token", name }, budget), null, 2));
  console.log(`cost: $${budget.total().toFixed(5)}`);
}
