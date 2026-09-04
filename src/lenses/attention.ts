import type { Attention, Lens, Resolved } from "../types.js";
import { sentiment, vibeTimeline, topKols, num } from "../lib/okx.js";
import { BudgetGuard } from "../pipeline/budget.js";
import { isCliEntry } from "../fixtures.js";
import { config } from "../config.js";
import { attentionCEX } from "./cex/attention.js";

// ATTENTION lens — OKX Social Analytics: vibe/hotness, sentiment, top KOLs.
// Token-scoped in v1; a pure narrative has no social endpoint → honest null.
export const attentionLens: Lens<Attention> = {
  name: "attention",
  async read(resolved: Resolved, budget: BudgetGuard): Promise<Attention | null> {
    if (config.exchange === "cex") return attentionCEX(resolved, budget);
    if (resolved.type !== "token" || !resolved.address || !resolved.chain) return null;

    const [sent, vibe, kols] = await Promise.all([
      sentiment(resolved.name, budget),
      vibeTimeline(resolved.chain, resolved.address, budget),
      topKols(resolved.chain, resolved.address, budget),
    ]);

    const summary = vibe?.summary;
    const detail = sent?.details?.[0];
    if (!summary && !detail) return null;

    const scoreChange = num(summary?.scoreChangeRate);
    const bull = num(detail?.sentiment?.bullishRatio);
    const bear = num(detail?.sentiment?.bearishRatio);

    return {
      hotness: summary ? Math.round((num(summary.score) ?? 0) * 10) / 10 : null,
      trend:
        scoreChange === null ? "unknown" : scoreChange > 5 ? "rising" : scoreChange < -5 ? "falling" : "flat",
      mentions_24h: num(detail?.mentionCount) ?? num(summary?.mentionsCount),
      sentiment:
        bull !== null && bear !== null
          ? { bull, bear, neutral: Math.max(0, Math.round((1 - bull - bear) * 1000) / 1000) }
          : null,
      top_kols: (kols?.kols ?? []).slice(0, 5).map((k) => ({
        handle: k.handle,
        impressions: num(k.impressions),
        followers: num(k.followers),
      })),
    };
  },
};

if (isCliEntry(import.meta.url)) {
  const { resolve } = await import("./resolve.js");
  const budget = new BudgetGuard();
  const resolved = await resolve(process.argv[2] ?? "pepe", budget);
  if (resolved.type !== "token" && resolved.type !== "narrative") throw new Error("this CLI expects a token/narrative query");
  const out = await attentionLens.read(resolved, budget);
  console.log(JSON.stringify({ resolved, attention: out }, null, 2));
  console.log(`cost: $${budget.total().toFixed(5)}`);
}
