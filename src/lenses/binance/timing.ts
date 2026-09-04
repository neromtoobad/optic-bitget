import type { Resolved } from "../../types.js";
import type { Timing } from "../timing.js";
import { tokenDynamic, toBnChain, num } from "../../lib/binance/web3.js";
import { findOnBoards } from "./attention.js";
import type { BudgetGuard } from "../../pipeline/budget.js";

// NARRATIVE TIMING (Binance edition) — early or late? Token age from Binance
// Web3 market data, attention trajectory from the social-hype 24h series, and
// onchain activity acceleration (1h volume run-rate vs the 24h average hour) as
// the tie-breaker when a token is too small for the social board.

export async function narrativeTimingBinance(resolved: Resolved, budget: BudgetGuard): Promise<Timing | null> {
  if (resolved.type !== "token" || !resolved.address || !resolved.chain) return null;
  const chain = toBnChain(resolved.chain) ?? resolved.chain;
  const [dyn, board] = await Promise.all([tokenDynamic(chain, resolved.address, budget), findOnBoards(resolved, budget)]);
  if (!dyn && !board) return null;

  const launched = dyn?.launchTime ?? null;
  const ageHours = launched ? Math.round(((Date.now() - launched) / 3_600_000) * 10) / 10 : null;

  // Social trajectory (relative hotness + % change over the series).
  let hotness: number | null = null;
  let hotChg: number | null = null;
  if (board) {
    const h = board.entry.socialHypeInfo?.socialHype ?? null;
    hotness = h !== null && board.max > 0 ? Math.round((100 * Math.log1p(h)) / Math.log1p(board.max) * 10) / 10 : null;
    const series = board.entry.socialHypeInfo?.socialHypeSerialChart ?? [];
    if (series.length >= 6) {
      const k = Math.min(6, Math.floor(series.length / 2));
      const avg = (xs: typeof series) => xs.reduce((a, x) => a + (x.socialHype ?? 0), 0) / xs.length;
      const a = avg(series.slice(0, k));
      const b = avg(series.slice(-k));
      hotChg = a > 0 ? Math.round(((b - a) / a) * 1000) / 10 : null;
    }
  }

  // Onchain activity acceleration as engagement proxy.
  const vol24 = num(dyn?.volume24h);
  const vol1h = num(dyn?.volume1h);
  const accel = vol24 && vol1h !== null ? vol1h / (vol24 / 24) : null;
  const engChg = accel !== null ? Math.round((accel - 1) * 1000) / 10 : null;

  const momentum = hotChg ?? engChg;
  const rising = momentum !== null && momentum > 15;
  const strongRising = momentum !== null && momentum > 60;
  const falling = momentum !== null && momentum < -15;
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
  const src = hotChg !== null ? "social hype" : "onchain activity";
  const read =
    stage === "igniting"
      ? `Early: ${ageStr}, ${src} accelerating ${momentum}% — narrative igniting before the crowd`
      : stage === "building"
        ? `Building: ${src} up ${momentum}%${hotness !== null ? `, hotness ${hotness}` : ""} — attention rising, ${ageStr}`
        : stage === "peaking"
          ? `Peaking: hotness ${hotness} but flat (${momentum ?? 0}%) — attention plateaued, ${ageStr}`
          : stage === "cooling"
            ? `Late: ${src} falling ${momentum}%${hotness !== null ? ` from hotness ${hotness}` : ""} — the move may be behind it, ${ageStr}`
            : `Quiet: ${hotness !== null ? `hotness ${hotness}, ` : ""}no momentum, ${ageStr}`;

  return { stage, read, age_hours: ageHours, hotness, hotness_change_pct: hotChg, engagement_change_pct: engChg };
}
