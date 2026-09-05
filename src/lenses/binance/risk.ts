import type { Resolved } from "../../types.js";
import type { RiskRadar } from "../risk.js";
import { tokenAudit, tokenDynamic, toBnChain, num, pct } from "../../lib/binance/web3.js";
import type { BudgetGuard } from "../../pipeline/budget.js";

// RUG RADAR (Binance edition) — Binance Web3's token security audit (the
// query-token-audit skill's endpoint: contract mechanisms, honeypot/tax checks,
// vendor flags) combined with holder composition from the token market data.
// A 0-100 score + concrete red flags. Disclosure, never advice.

export async function riskRadarBinance(resolved: Resolved, budget: BudgetGuard): Promise<RiskRadar | null> {
  if (resolved.type !== "token" || !resolved.address || !resolved.chain) return null;
  const chain = toBnChain(resolved.chain) ?? resolved.chain;
  const [audit, dyn] = await Promise.all([tokenAudit(chain, resolved.address, budget), tokenDynamic(chain, resolved.address, budget)]);
  if (!audit?.hasResult && !dyn) return null;

  const flags: string[] = [];
  const positives: string[] = [];
  let score = 0;

  // Audit hits: each hit item is a concrete mechanism found in the contract.
  const hits: string[] = [];
  const clean: string[] = [];
  for (const item of audit?.riskItems ?? []) {
    for (const d of item.details ?? []) {
      if (d.isHit) {
        hits.push(d.title);
        score += d.riskType === "RISK" || /honeypot|cannot sell|blacklist|hidden owner|self.?destruct/i.test(d.title) ? 18 : 6;
      } else if (/honeypot|mint|blacklist|proxy|hidden owner|cannot sell/i.test(d.title)) {
        clean.push(d.title);
      }
    }
  }
  flags.push(...hits.slice(0, 5).map((t) => `audit: ${t.toLowerCase()}`));
  positives.push(...clean.slice(0, 3).map((t) => `audit: ${t.toLowerCase()}`));

  const buyTax = num(audit?.extraInfo?.buyTax);
  const sellTax = num(audit?.extraInfo?.sellTax);
  if ((buyTax ?? 0) >= 10 || (sellTax ?? 0) >= 10 || audit?.extraInfo?.unusualBuyTax || audit?.extraInfo?.unusualSellTax) {
    score += 12;
    flags.push(`transfer tax ${buyTax ?? "?"}% in / ${sellTax ?? "?"}% out${audit?.extraInfo?.unusualSellTax ? " (flagged unusual)" : ""}`);
  } else if (buyTax === 0 && sellTax === 0) positives.push("no transfer tax");

  if (audit?.riskLevelEnum === "HIGH") score += 25;
  else if (audit?.riskLevelEnum === "MID") score += 8;
  else if (audit?.riskLevelEnum === "LOW") positives.push("Binance security audit: low risk");

  // Holder composition.
  const top10 = num(dyn?.top10HoldersPercentage);
  const dev = pct(dyn?.devHoldingPercent ?? dyn?.holdersDevPercent);
  const bundlers = pct(dyn?.bundlerHoldingPercent);
  const snipers = pct(dyn?.sniperHoldingPercent);
  const insiders = pct(dyn?.insiderHoldingPercent);
  const holders = num(dyn?.holders);
  if (top10 !== null && top10 >= 70) {
    score += 12;
    flags.push(`top-10 wallets hold ${Math.round(top10 * 10) / 10}% — highly concentrated`);
  } else if (top10 !== null && top10 <= 40) positives.push(`top-10 hold only ${Math.round(top10 * 10) / 10}% — well distributed`);
  if (dev !== null && dev >= 20) {
    score += 15;
    flags.push(`dev wallets hold ${dev}% of supply`);
  }
  if (bundlers !== null && bundlers >= 15) {
    score += 10;
    flags.push(`bundlers hold ${bundlers}%`);
  }
  if (snipers !== null && snipers >= 10) {
    score += 8;
    flags.push(`snipers hold ${snipers}%`);
  }
  if (insiders !== null && insiders >= 20) {
    score += 10;
    flags.push(`insiders hold ${insiders}%`);
  }
  if (holders !== null && holders < 200) {
    score += 8;
    flags.push(`only ${holders} holders`);
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const level: RiskRadar["level"] = score >= 65 ? "danger" : score >= 40 ? "elevated" : score >= 20 ? "caution" : "clean";
  return {
    score,
    level,
    flags,
    positives,
    data: {
      audit_level: audit?.riskLevelEnum ?? null,
      audit_hits: hits.length,
      buy_tax_pct: buyTax,
      sell_tax_pct: sellTax,
      top10_holding_pct: top10,
      dev_holding_pct: dev,
      bundler_holding_pct: bundlers,
      sniper_holding_pct: snipers,
      insider_holding_pct: insiders,
      holders,
      source: "binance-web3:token-audit",
    },
  };
}
