import type { Resolved } from "../types.js";
import { BudgetGuard } from "../pipeline/budget.js";
import { isCliEntry } from "../fixtures.js";
import { riskRadarCEX } from "./cex/risk.js";

// RUG RADAR — token safety diligence. Combines the CEX Web3 token audit and
// holder composition into a 0-100 risk score + concrete red flags. This prevents
// losses: it exposes contract mechanisms, transfer taxes, and dev/sniper/bundler
// capture that a price chart never shows. Risk disclosure, not advice — factual
// flags a trader must see before touching a token.

export interface RiskRadar {
  score: number; // 0 (clean) .. 100 (dangerous)
  level: "clean" | "caution" | "elevated" | "danger";
  flags: string[]; // concrete red flags, worst first
  positives: string[]; // reassuring signals
  data: Record<string, number | string | null>;
}

export async function riskRadar(resolved: Resolved, budget: BudgetGuard): Promise<RiskRadar | null> {
  return riskRadarCEX(resolved, budget);
}

if (isCliEntry(import.meta.url)) {
  const budget = new BudgetGuard();
  const name = process.argv.slice(2).join(" ") || "BTC";
  console.log(JSON.stringify(await riskRadar({ type: "token", name }, budget), null, 2));
  console.log(`cost: $${budget.total().toFixed(5)}`);
}
