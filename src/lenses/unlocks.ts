import type { Resolved, UnlockNews } from "../types.js";
import { BudgetGuard } from "../pipeline/budget.js";

// UNLOCK lens — supply-event intelligence: unlock calendars, vesting cliffs,
// emission events.
//
// The Binance kit exposes no unlock/vesting news feed, so every entry point here
// reports absence rather than inventing a supply event. That is the honest read:
// a verdict says "no scheduled supply event surfaced", never a fabricated one.
// Wire this to a real feed and the pipeline picks it up with no other change.

/** Unlock/vesting news mentioning this token. */
export async function unlockNewsFor(_resolved: Resolved, _budget: BudgetGuard): Promise<UnlockNews[] | null> {
  return null;
}

/** Research headlines for a narrative subject (sports, macro, events). */
export async function newsFor(_resolved: Resolved, _budget: BudgetGuard): Promise<UnlockNews[] | null> {
  return null;
}

/** Market-wide unlock calendar chatter (for scan mode). */
export async function unlockCalendar(_budget: BudgetGuard): Promise<UnlockNews[]> {
  return [];
}
