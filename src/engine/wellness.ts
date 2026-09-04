import type { WalletTx } from "../lenses/wallet.js";

// TOUCHGRASS engine — deterministic behavior patterns + 0–100 wellness score
// from tx timestamps alone. Every pattern carries the stat that produced it, so
// each prescription downstream is traceable to observed behavior. No PnL, no
// balances, no judgement about trades — only when the wallet acts.

export type Severity = "info" | "mild" | "elevated" | "severe";

export interface Pattern {
  id: "late_night" | "always_on" | "grass_drought" | "weekend_grind" | "burst_sessions" | "marathon";
  label: string;
  stat: string; // the observed number behind the finding, human-readable
  severity: Severity;
  deduction: number;
}

export interface WellnessStats {
  window_days: number;
  total_txs: number;
  active_days: number;
  night_pct: number; // % of txs 00:00–05:59 local
  weekend_pct: number;
  longest_break_h: number; // longest gap between consecutive txs
  longest_session_h: number; // txs chained with <45min gaps
  burst_count: number; // sessions of ≥5 txs within 10 min
  busiest_hour: number; // local hour with most txs
}

export interface Wellness {
  score: number;
  persona: string;
  timezone: string;
  stats: WellnessStats;
  patterns: Pattern[]; // sorted worst-first
  positives: string[]; // honest credit where due
  gym_window: string | null; // quietest recurring weekday 2h block
}

const WINDOW_DAYS = 90;
const DAY_S = 86_400;

interface LocalTx {
  ts: number;
  hour: number; // 0–23 local
  dow: number; // 0=Sun … 6=Sat local
  dayKey: string;
}

function toLocal(txs: WalletTx[], timezone: string): LocalTx[] {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    hour12: false,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return txs.map((t) => {
    const parts = Object.fromEntries(fmt.formatToParts(new Date(t.ts * 1000)).map((p) => [p.type, p.value]));
    return {
      ts: t.ts,
      hour: Number(parts.hour) % 24,
      dow: DOW[parts.weekday] ?? 0,
      dayKey: `${parts.year}-${parts.month}-${parts.day}`,
    };
  });
}

const pct = (n: number, d: number): number => (d === 0 ? 0 : Math.round((n / d) * 1000) / 10);

const PERSONAS: Array<[number, string]> = [
  [85, "Zen Gardener"],
  [65, "Grass-Adjacent"],
  [45, "Chart Goblin"],
  [25, "Vitamin D Deficient"],
  [0, "Grass Emergency"],
];

/**
 * Validate an IANA timezone; fall back to UTC rather than crash a paid read on
 * a typo'd input. The verdict always reports which timezone was actually used.
 */
export function safeTimezone(tz: string | undefined): string {
  if (!tz) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

export function computeWellness(txs: WalletTx[], timezone: string): Wellness {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - WINDOW_DAYS * DAY_S;
  const inWindow = txs.filter((t) => t.ts >= windowStart && t.ts <= now).sort((a, b) => a.ts - b.ts);
  const local = toLocal(inWindow, timezone);

  const stats: WellnessStats = {
    window_days: WINDOW_DAYS,
    total_txs: inWindow.length,
    active_days: new Set(local.map((t) => t.dayKey)).size,
    night_pct: pct(local.filter((t) => t.hour < 6).length, local.length),
    weekend_pct: pct(local.filter((t) => t.dow === 0 || t.dow === 6).length, local.length),
    longest_break_h: 0,
    longest_session_h: 0,
    burst_count: 0,
    busiest_hour: 0,
  };

  // Gaps, sessions, bursts — one pass over the sorted timeline.
  let sessionStart = inWindow[0]?.ts ?? 0;
  let prev = inWindow[0]?.ts ?? 0;
  let burstWindow: number[] = [];
  const counted = new Set<number>(); // a burst counted once per session-start
  for (const t of inWindow) {
    const gap = t.ts - prev;
    if (gap > stats.longest_break_h * 3600) stats.longest_break_h = Math.round((gap / 3600) * 10) / 10;
    if (gap > 45 * 60) sessionStart = t.ts;
    const sessionH = (t.ts - sessionStart) / 3600;
    if (sessionH > stats.longest_session_h) stats.longest_session_h = Math.round(sessionH * 10) / 10;
    burstWindow = burstWindow.filter((ts) => t.ts - ts <= 600);
    burstWindow.push(t.ts);
    if (burstWindow.length >= 5 && !counted.has(sessionStart)) {
      counted.add(sessionStart);
      stats.burst_count++;
    }
    prev = t.ts;
  }
  // Tail gap: silence since the last tx is also a break (a wallet quiet for a
  // week must not read as "never logs off").
  if (inWindow.length) {
    const tail = (now - inWindow[inWindow.length - 1].ts) / 3600;
    if (tail > stats.longest_break_h) stats.longest_break_h = Math.round(tail * 10) / 10;
  }
  const hourCounts = new Array(24).fill(0);
  for (const t of local) hourCounts[t.hour]++;
  stats.busiest_hour = hourCounts.indexOf(Math.max(...hourCounts));

  // Not enough behavior to read — honest early return, no invented patterns.
  if (inWindow.length < 10) {
    return {
      score: 92,
      persona: "Zen Gardener",
      timezone,
      stats,
      patterns: [],
      positives: [
        inWindow.length === 0
          ? `no onchain activity in the last ${WINDOW_DAYS} days — the grass is being touched`
          : `only ${inWindow.length} transactions in ${WINDOW_DAYS} days — chain time is not running your life`,
      ],
      gym_window: gymWindow(local),
    };
  }

  const patterns: Pattern[] = [];
  const add = (p: Pattern) => patterns.push(p);

  if (stats.night_pct >= 30)
    add({ id: "late_night", label: "night owl trading", stat: `${stats.night_pct}% of activity between midnight and 6am`, severity: "severe", deduction: 22 });
  else if (stats.night_pct >= 15)
    add({ id: "late_night", label: "night owl trading", stat: `${stats.night_pct}% of activity between midnight and 6am`, severity: "elevated", deduction: 14 });
  else if (stats.night_pct >= 6)
    add({ id: "late_night", label: "occasional late nights", stat: `${stats.night_pct}% of activity between midnight and 6am`, severity: "mild", deduction: 6 });

  const activeRatio = stats.active_days / WINDOW_DAYS;
  if (activeRatio >= 0.9)
    add({ id: "always_on", label: "always on-chain", stat: `active ${stats.active_days} of ${WINDOW_DAYS} days`, severity: "severe", deduction: 18 });
  else if (activeRatio >= 0.7)
    add({ id: "always_on", label: "nearly always on-chain", stat: `active ${stats.active_days} of ${WINDOW_DAYS} days`, severity: "elevated", deduction: 11 });
  else if (activeRatio >= 0.5)
    add({ id: "always_on", label: "on-chain most days", stat: `active ${stats.active_days} of ${WINDOW_DAYS} days`, severity: "mild", deduction: 5 });

  if (stats.longest_break_h < 24)
    add({ id: "grass_drought", label: "no full day offchain", stat: `longest break in ${WINDOW_DAYS} days: ${stats.longest_break_h}h`, severity: "severe", deduction: 12 });
  else if (stats.longest_break_h < 48)
    add({ id: "grass_drought", label: "short offchain breaks", stat: `longest break in ${WINDOW_DAYS} days: ${Math.round(stats.longest_break_h)}h`, severity: "mild", deduction: 6 });

  if (stats.weekend_pct >= 40)
    add({ id: "weekend_grind", label: "weekend grinding", stat: `${stats.weekend_pct}% of activity on weekends`, severity: "elevated", deduction: 10 });
  else if (stats.weekend_pct >= 33)
    add({ id: "weekend_grind", label: "busy weekends", stat: `${stats.weekend_pct}% of activity on weekends`, severity: "mild", deduction: 5 });

  const burstsPerWeek = stats.burst_count / (WINDOW_DAYS / 7);
  if (burstsPerWeek >= 5)
    add({ id: "burst_sessions", label: "rapid-fire sessions", stat: `${stats.burst_count} bursts of 5+ txs inside 10 minutes`, severity: "severe", deduction: 14 });
  else if (burstsPerWeek >= 2)
    add({ id: "burst_sessions", label: "rapid-fire sessions", stat: `${stats.burst_count} bursts of 5+ txs inside 10 minutes`, severity: "elevated", deduction: 8 });
  else if (stats.burst_count >= 1)
    add({ id: "burst_sessions", label: "occasional rapid-fire", stat: `${stats.burst_count} bursts of 5+ txs inside 10 minutes`, severity: "mild", deduction: 4 });

  if (stats.longest_session_h >= 5)
    add({ id: "marathon", label: "marathon sessions", stat: `longest continuous session: ${stats.longest_session_h}h`, severity: "severe", deduction: 12 });
  else if (stats.longest_session_h >= 3)
    add({ id: "marathon", label: "multi-hour sessions", stat: `longest continuous session: ${stats.longest_session_h}h`, severity: "elevated", deduction: 7 });
  else if (stats.longest_session_h >= 1.5)
    add({ id: "marathon", label: "extended sessions", stat: `longest continuous session: ${stats.longest_session_h}h`, severity: "mild", deduction: 3 });

  const order: Record<Severity, number> = { severe: 0, elevated: 1, mild: 2, info: 3 };
  patterns.sort((a, b) => order[a.severity] - order[b.severity] || b.deduction - a.deduction);

  const positives: string[] = [];
  if (stats.night_pct < 6) positives.push("nights are for sleep — almost no midnight-to-6am activity");
  if (stats.longest_break_h >= 72) positives.push(`took a real ${Math.round(stats.longest_break_h / 24)}-day offchain break`);
  if (stats.weekend_pct < 20) positives.push("weekends stay mostly offchain");
  if (stats.burst_count === 0) positives.push("no rapid-fire sessions — actions look considered, not compulsive");

  const score = Math.max(3, Math.min(100, 100 - patterns.reduce((s, p) => s + p.deduction, 0)));
  const persona = PERSONAS.find(([min]) => score >= min)![1];

  return { score, persona, timezone, stats, patterns, positives, gym_window: gymWindow(local) };
}

/**
 * Quietest recurring weekday 2-hour block between 06:00 and 22:00 local — the
 * wallet's own histogram says when its human is reliably free to train.
 */
function gymWindow(local: LocalTx[]): string | null {
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  let best: { dow: number; hour: number; count: number } | null = null;
  for (let dow = 1; dow <= 5; dow++) {
    for (let hour = 6; hour <= 20; hour += 2) {
      const count = local.filter((t) => t.dow === dow && t.hour >= hour && t.hour < hour + 2).length;
      // Prefer evening slots on ties — most trainable for most people.
      if (!best || count < best.count || (count === best.count && hour >= 16 && best.hour < 16)) {
        best = { dow, hour, count };
      }
    }
  }
  if (!best) return null;
  const h = (n: number) => `${String(n).padStart(2, "0")}:00`;
  return `${DAYS[best.dow]} ${h(best.hour)}–${h(best.hour + 2)}`;
}
