// Smoke the desk's EVIDENCE TABLE against live sources — no model calls except
// the research row, which reports "error" honestly when no LLM key is set.
//   npx tsx scripts/smoke-desk-evidence.ts NVDA "NVIDIA"
import { BudgetGuard } from "../src/pipeline/budget.js";
import { gatherEvidence } from "../src/desk/evidence.js";
import { closeSignalMcp } from "../src/lib/bitget/signal.js";

const [ticker = "NVDA", company = "NVIDIA"] = process.argv.slice(2);
const budget = new BudgetGuard();
const t0 = Date.now();
const ev = await gatherEvidence(`Long ${ticker} perp into earnings — funding looks cheap`, ticker, company, budget);
console.log(`gathered in ${((Date.now() - t0) / 1000).toFixed(1)}s · symbol=${ev.symbol} · coverage=${JSON.stringify(ev.coverage)}`);
console.log("\nGAP:", JSON.stringify(ev.gap, null, 2));
console.log("\nROWS:");
for (const r of ev.rows) {
  const v = r.status === "ok" ? (typeof r.value === "string" ? r.value : JSON.stringify(r.value)).slice(0, 220) : "";
  console.log(`  [${r.id.padEnd(11)}] ${r.status.padEnd(7)} computed=${String(r.computed).padEnd(5)} ${r.source.padEnd(34)} ${r.note ?? ""}${v ? "\n      " + v : ""}`);
}
console.log(`\ncost: $${budget.total().toFixed(4)}`);
await closeSignalMcp();
process.exit(0);
