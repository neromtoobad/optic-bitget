import type { ScanVerdict } from "../types.js";
import { BudgetGuard } from "../pipeline/budget.js";
import { isCliEntry } from "../fixtures.js";
import { runScanCEX } from "./cex.js";

/** Discovery read: where is attention accelerating before it's crowded. */
export async function runScan(budget: BudgetGuard): Promise<Omit<ScanVerdict, "card_url" | "card_pending">> {
  return runScanCEX(budget);
}

if (isCliEntry(import.meta.url)) {
  const budget = new BudgetGuard();
  const out = await runScan(budget);
  console.log(JSON.stringify(out, null, 2));
  console.log(`cost: $${budget.total().toFixed(5)}`);
}
