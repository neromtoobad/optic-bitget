import type { TouchGrassVerdict } from "../types.js";
import type { BudgetGuard } from "../pipeline/budget.js";
import { walletActivity } from "../lenses/wallet.js";
import { computeWellness, safeTimezone } from "../engine/wellness.js";
import { buildProtocol } from "../engine/protocol.js";
import { isCliEntry } from "../fixtures.js";

export interface TouchGrassOpts {
  city?: string;
  tz?: string;
}

/**
 * TOUCHGRASS read: wallet address → onchain behavior patterns → wellness score
 * → personalized protocol (grass / fuel / move) + verdict line. Diagnosis before
 * prescription: every suggestion traces to an observed pattern. Entertainment +
 * self-reflection framing — observational wellness, never medical, never advice.
 */
export async function runTouchGrass(query: string, opts: TouchGrassOpts, budget: BudgetGuard): Promise<Omit<TouchGrassVerdict, "card_url">> {
  const timezone = safeTimezone(opts.tz);
  const activity = await walletActivity(query, budget);

  if (!activity) {
    return {
      query,
      resolved: { type: "touchgrass", name: "touchgrass", address: query, chains: [] },
      wellness: null,
      protocol: null,
      verdict_line: `"${query.slice(0, 40)}" is not a wallet address TouchGrass can read — provide an EVM (0x…) or Solana address.`,
      generated_at: new Date().toISOString(),
    };
  }

  const wellness = computeWellness(activity.txs, timezone);
  const { protocol, verdict_line } = await buildProtocol(wellness, { city: opts.city }, budget);

  return {
    query,
    resolved: {
      type: "touchgrass",
      name: wellness.persona,
      address: activity.address,
      chains: activity.chains,
    },
    wellness,
    protocol,
    verdict_line,
    generated_at: new Date().toISOString(),
  };
}

if (isCliEntry(import.meta.url)) {
  const { BudgetGuard } = await import("../pipeline/budget.js");
  const [address, city, tz] = process.argv.slice(2);
  if (!address) {
    console.error('usage: npm run touchgrass -- <address> [city] [tz]   e.g. npm run touchgrass -- 0xd8dA… Lagos Africa/Lagos');
    process.exit(1);
  }
  const budget = new BudgetGuard();
  const v = await runTouchGrass(address, { city, tz }, budget);
  console.log(JSON.stringify(v, null, 2));
  console.error(`cost: $${budget.total().toFixed(4)}`);
}
