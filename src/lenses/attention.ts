import type { Attention, Lens, Resolved } from "../types.js";
import { BudgetGuard } from "../pipeline/budget.js";
import { isCliEntry } from "../fixtures.js";
import { attentionBinance } from "./binance/attention.js";

// ATTENTION lens — Binance Square social hype: hotness, sentiment, top posters.
// Token-scoped; a pure narrative has no social endpoint → honest null.
export const attentionLens: Lens<Attention> = {
  name: "attention",
  read: (resolved: Resolved, budget: BudgetGuard) => attentionBinance(resolved, budget),
};

if (isCliEntry(import.meta.url)) {
  const budget = new BudgetGuard();
  const name = process.argv.slice(2).join(" ") || "BTC";
  console.log(JSON.stringify(await attentionLens.read({ type: "token", name }, budget), null, 2));
  console.log(`cost: $${budget.total().toFixed(5)}`);
}
