import type { Resolved, UnlockNews } from "../types.js";
import { newsSearch, type NewsArticle } from "../lib/okx.js";
import { BudgetGuard } from "../pipeline/budget.js";
import { isCliEntry } from "../fixtures.js";
import { config } from "../config.js";

// UNLOCK lens — supply-event intelligence from the news layer: unlock calendars,
// vesting cliffs, emission events. Factual reporting only; the divergence engine
// may observe that supply pressure is scheduled — never that anyone should act.

function toUnlockNews(a: NewsArticle): UnlockNews {
  return {
    title: a.title,
    summary: a.summary || null,
    importance: a.importance ?? null,
    source: a.source ?? null,
    published_at: a.timestamp ? new Date(a.timestamp).toISOString() : null,
  };
}

/** Unlock/vesting news mentioning this token (symbol match), newest first. */
export async function unlockNewsFor(resolved: Resolved, budget: BudgetGuard): Promise<UnlockNews[] | null> {
  if (config.exchange === "cex") return null; // no unlock-news feed in the CEX kit — absence reported honestly
  if (resolved.type !== "token") return null;
  const res = await newsSearch("unlock", 20, budget);
  const articles = res?.articles ?? [];
  const sym = resolved.name.toUpperCase();
  const hits = articles.filter(
    (a) =>
      (a.tokenSymbols ?? []).some((s) => s.toUpperCase() === sym) ||
      `${a.title} ${a.summary ?? ""}`.toUpperCase().includes(` ${sym} `) ||
      `${a.title} ${a.summary ?? ""}`.toUpperCase().includes(`${sym} (`)
  );
  return hits.length > 0 ? hits.slice(0, 5).map(toUnlockNews) : null;
}

/** Research headlines for a narrative subject (sports, macro, events). */
export async function newsFor(resolved: Resolved, budget: BudgetGuard): Promise<UnlockNews[] | null> {
  if (config.exchange === "cex") return null;
  if (resolved.type !== "narrative") return null;
  const res = await newsSearch(resolved.name.split(/\s+/).slice(0, 3).join(" "), 10, budget);
  const articles = (res?.articles ?? []).slice(0, 5).map(toUnlockNews);
  return articles.length > 0 ? articles : null;
}

/** Market-wide unlock calendar chatter (for scan mode). */
export async function unlockCalendar(budget: BudgetGuard): Promise<UnlockNews[]> {
  if (config.exchange === "cex") return [];
  const res = await newsSearch("token unlock", 10, budget);
  return (res?.articles ?? [])
    .filter((a) => /unlock/i.test(`${a.title} ${a.summary ?? ""}`))
    .slice(0, 5)
    .map(toUnlockNews);
}

if (isCliEntry(import.meta.url)) {
  const budget = new BudgetGuard();
  const arg = process.argv[2];
  const out = arg
    ? await unlockNewsFor({ type: "token", name: arg.toUpperCase() }, budget)
    : await unlockCalendar(budget);
  console.log(JSON.stringify(out, null, 2));
  console.log(`cost: $${budget.total().toFixed(5)}`);
}
