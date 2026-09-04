import type { Resolved } from "../types.js";
import { clusterOverview, advancedInfo, num } from "../lib/okx.js";
import { BudgetGuard } from "../pipeline/budget.js";
import { isCliEntry } from "../fixtures.js";
import { config } from "../config.js";
import { riskRadarCEX } from "./cex/risk.js";

// RUG RADAR — token safety diligence. Combines OKX holder-cluster analysis and
// advanced dev/bundle info into a 0-100 risk score + concrete red flags. This
// prevents losses: it exposes dev rug history, holder collusion, bundler/sniper
// capture, and LP status that a price chart never shows. Risk disclosure, not
// advice — factual flags a trader must see before touching a token.

export interface RiskRadar {
  score: number; // 0 (clean) .. 100 (dangerous)
  level: "clean" | "caution" | "elevated" | "danger";
  flags: string[]; // concrete red flags, worst first
  positives: string[]; // reassuring signals
  data: Record<string, number | string | null>;
}

const pct = (s: string | undefined): number | null => {
  const n = num(s ?? null);
  if (n === null) return null;
  return n <= 1 ? Math.round(n * 1000) / 10 : Math.round(n * 10) / 10; // some fields are 0-1, some 0-100
};

export async function riskRadar(resolved: Resolved, budget: BudgetGuard): Promise<RiskRadar | null> {
  if (config.exchange === "cex") return riskRadarCEX(resolved, budget);
  if (resolved.type !== "token" || !resolved.address || !resolved.chain) return null;

  const [cluster, adv] = await Promise.all([
    clusterOverview(resolved.chain, resolved.address, budget),
    advancedInfo(resolved.chain, resolved.address, budget),
  ]);
  if (!cluster && !adv) return null;

  const flags: string[] = [];
  const positives: string[] = [];
  let score = 0;

  const devRugs = num(adv?.devRugPullTokenCount);
  const devLaunched = num(adv?.devLaunchedTokenCount);
  const devHold = pct(adv?.devHoldingPercent);
  const bundle = pct(adv?.bundleHoldingPercent);
  const lpBurned = pct(adv?.lpBurnedPercent);
  const rugPull = pct(cluster?.rugPullPercent);
  const sameFund = pct(cluster?.holderSameFundSourcePercent);
  const top100 = pct(cluster?.top100HoldingsPercent);
  const concentration = cluster?.clusterConcentration;

  // Dev rug history — the deadliest signal.
  if (devRugs !== null && devRugs > 0) {
    score += Math.min(35, devRugs * 15);
    flags.push(`dev has rug-pulled ${devRugs} prior token${devRugs > 1 ? "s" : ""}${devLaunched ? ` of ${devLaunched} launched` : ""}`);
  } else if (devLaunched !== null && devLaunched > 0) {
    positives.push(`dev launched ${devLaunched} tokens, none flagged as rug-pulls`);
  }

  // Dev / bundle / concentration capture.
  if (devHold !== null && devHold >= 20) {
    score += Math.min(20, devHold / 2);
    flags.push(`dev holds ${devHold}% of supply`);
  }
  if (bundle !== null && bundle >= 15) {
    score += Math.min(15, bundle / 2);
    flags.push(`bundlers hold ${bundle}%`);
  }
  if (top100 !== null && top100 >= 70) {
    score += 12;
    flags.push(`top-100 wallets hold ${top100}% — highly concentrated`);
  } else if (top100 !== null && top100 <= 40) {
    positives.push(`top-100 hold only ${top100}% — well distributed`);
  }
  if (sameFund !== null && sameFund >= 40) {
    score += 12;
    flags.push(`${sameFund}% of holders share a funding source — possible collusion`);
  }
  if (rugPull !== null && rugPull >= 10) {
    score += 10;
    flags.push(`${rugPull}% of holders flagged rug-pull-linked`);
  }
  if (concentration === "High") {
    score += 10;
    flags.push("holder-cluster concentration: High");
  } else if (concentration === "Low") {
    positives.push("holder-cluster concentration: Low");
  }

  // LP burned is reassuring; un-burned LP is a pull risk.
  if (lpBurned !== null) {
    if (lpBurned >= 90) positives.push(`LP ${lpBurned}% burned`);
    else if (lpBurned < 50) {
      score += 12;
      flags.push(`only ${lpBurned}% of LP burned — liquidity could be pulled`);
    }
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const level: RiskRadar["level"] = score >= 65 ? "danger" : score >= 40 ? "elevated" : score >= 20 ? "caution" : "clean";

  return {
    score,
    level,
    flags,
    positives,
    data: {
      dev_rug_history: devRugs,
      dev_holding_pct: devHold,
      bundle_holding_pct: bundle,
      top100_holding_pct: top100,
      same_fund_source_pct: sameFund,
      lp_burned_pct: lpBurned,
      cluster_concentration: concentration ?? null,
    },
  };
}

if (isCliEntry(import.meta.url)) {
  const { resolve } = await import("./resolve.js");
  const budget = new BudgetGuard();
  const resolved = await resolve(process.argv[2] ?? "pepe", budget);
  if (resolved.type !== "token") throw new Error("risk radar needs a token");
  const out = await riskRadar(resolved, budget);
  console.log(JSON.stringify(out, null, 2));
  console.log(`cost: $${budget.total().toFixed(5)}`);
}
