import type { Resolved } from "../types.js";
import { memeTokenDetails, vibeTimeline, num } from "../lib/okx.js";
import { BudgetGuard } from "../pipeline/budget.js";
import { isCliEntry } from "../fixtures.js";
import { config } from "../config.js";
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
  if (config.exchange === "binance") return narrativeTimingBinance(resolved, budget);
  if (resolved.type !== "token" || !resolved.address || !resolved.chain) return null;

  const [details, vibe] = await Promise.all([
    memeTokenDetails(resolved.chain, resolved.address, budget),
    vibeTimeline(resolved.chain, resolved.address, budget),
  ]);
  const s = vibe?.summary;
  if (!s && !details) return null;

  const created = num((details as { createdTimestamp?: string } | null)?.createdTimestamp);
  const ageHours = created ? Math.round(((Date.now() - created) / 3_600_000) * 10) / 10 : null;
  const hotness = s ? Math.round((num(s.score) ?? 0) * 10) / 10 : null;
  const hotChg = num(s?.scoreChangeRate);
  const engChg = num(s?.engagementChangeRate);

  // Classify lifecycle from hotness trajectory + age. Rising hotness on a young
  // token = igniting; strong rise = building; high + flat = peaking; falling = cooling.
  const rising = hotChg !== null && hotChg > 15;
  const strongRising = hotChg !== null && hotChg > 60;
  const falling = hotChg !== null && hotChg < -15;
  const hot = hotness !== null && hotness >= 50;
  const young = ageHours !== null && ageHours <= 72;

  let stage: Timing["stage"];
  if (falling && hot) stage = "cooling";
  else if (strongRising && young) stage = "igniting";
  else if (rising) stage = "building";
  else if (hot && !rising && !falling) stage = "peaking";
  else if (falling) stage = "cooling";
  else stage = "quiet";

  const ageStr = ageHours === null ? "age unknown" : ageHours < 48 ? `${Math.round(ageHours)}h old` : `${Math.round(ageHours / 24)}d old`;
  const read =
    stage === "igniting"
      ? `Early: ${ageStr}, hotness ${hotness} and accelerating ${hotChg}% — narrative igniting before the crowd`
      : stage === "building"
        ? `Building: hotness ${hotness}, up ${hotChg}% — attention rising, ${ageStr}`
        : stage === "peaking"
          ? `Peaking: hotness ${hotness} but flat (${hotChg ?? 0}%) — attention plateaued, ${ageStr}`
          : stage === "cooling"
            ? `Late: hotness ${hotness} and falling ${hotChg}% — the move may be behind it, ${ageStr}`
            : `Quiet: hotness ${hotness ?? "n/a"}, no momentum, ${ageStr}`;

  return { stage, read, age_hours: ageHours, hotness, hotness_change_pct: hotChg, engagement_change_pct: engChg };
}

if (isCliEntry(import.meta.url)) {
  const { resolve } = await import("./resolve.js");
  const budget = new BudgetGuard();
  const resolved = await resolve(process.argv[2] ?? "pepe", budget);
  if (resolved.type !== "token") throw new Error("timing needs a token");
  const out = await narrativeTiming(resolved, budget);
  console.log(JSON.stringify(out, null, 2));
  console.log(`cost: $${budget.total().toFixed(5)}`);
}
