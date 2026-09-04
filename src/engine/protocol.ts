import type { Wellness, Pattern } from "./wellness.js";
import type { BudgetGuard } from "../pipeline/budget.js";
import { structuredCall } from "../lib/anthropic.js";
import { lintVerdictStrings } from "../lint.js";
import { cached } from "../db.js";

// TOUCHGRASS protocol — diagnosis first, prescription second. Every item below
// is selected BY a detected pattern (or an explicit healthy default); nothing
// generic ships. Wellness suggestions only — never diagnostic or medical claims.

export interface Protocol {
  grass: string[]; // offchain activities, matched to the worst patterns
  fuel: string[]; // food/routine suggestions tied to the observed clock
  move: { window: string | null; starter: string };
  weather_note: string | null; // present only when a city was provided
}

// pattern id → prescription. Worst patterns pick first; each entry references
// the behavior it answers so the "traceable to the data" rule is visible.
const GRASS_RX: Record<Pattern["id"], (p: Pattern) => string> = {
  late_night: () => "Morning sunlight walk — 20 minutes outside within an hour of waking, before opening any chart. It is the fastest reset for a clock that runs past midnight.",
  burst_sessions: () => "Burst rule: after any rapid-fire streak, a 20-minute walk with the phone left at home. The chain will still be there when you get back.",
  grass_drought: (p) => `Book one full offchain day this week — ${p.stat.replace("longest break in 90 days: ", "your longest break in 90 days was ")}.`,
  always_on: () => "Schedule one screen-free half-day this weekend. Put it in the calendar like a meeting; treat the calendar as final.",
  marathon: () => "The 90-minute rule: every 90 minutes of screen time, 5 minutes outside with eyes on something far away.",
  weekend_grind: () => "Reclaim one weekend morning: outside before 10am, coffee in hand, wallet untouched until noon.",
};

const FUEL_RX: Record<string, (w: Wellness) => string | null> = {
  late_night: (w) => {
    const p = w.patterns.find((x) => x.id === "late_night");
    if (!p) return null;
    return "Caffeine curfew: nothing caffeinated within 8 hours of your usual last transaction — night-heavy activity and late coffee feed each other.";
  },
  marathon: (w) =>
    w.patterns.some((x) => x.id === "marathon")
      ? "Marathon sessions run on snacks. Anchor one real, sit-down meal before any session you expect to run past an hour."
      : null,
  always_on: (w) =>
    w.patterns.some((x) => x.id === "always_on")
      ? "A protein-forward breakfast at a fixed time gives an always-on schedule its one non-negotiable anchor."
      : null,
  hydration: (w) => (w.stats.total_txs >= 10 ? "Water on the desk before the wallet unlocks — a full glass per session is the cheapest upgrade available." : null),
};

const STARTERS: Array<{ when: (w: Wellness) => boolean; starter: string }> = [
  {
    when: (w) => w.score < 45,
    starter: "Starter: 30-minute full-body basics, 3 rounds — squat, push-up, row, farmer carry. Twice a week beats an ambitious plan that never happens.",
  },
  {
    when: (w) => w.score < 85,
    starter: "Starter: 45 minutes, 3 times a week — one push day, one pull day, one legs-and-walk day. Consistency over intensity.",
  },
  {
    when: () => true,
    starter: "Your schedule already has room — a 45-minute session in the window below keeps it that way.",
  },
];

interface Weather {
  temp_c: number;
  precip_prob: number;
  label: string; // resolved place name
}

/** Tomorrow ~8am local conditions for a city — free Open-Meteo, cached, optional. */
async function morningWeather(city: string, budget: BudgetGuard): Promise<Weather | null> {
  try {
    const { value } = await cached("open-meteo", { city: city.toLowerCase() }, async () => {
      budget.register("weather:open-meteo", 0);
      const geo = (await (
        await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`, {
          signal: AbortSignal.timeout(8000),
        })
      ).json()) as { results?: Array<{ latitude: number; longitude: number; name: string; timezone: string }> };
      const hit = geo.results?.[0];
      if (!hit) return null;
      const fc = (await (
        await fetch(
          `https://api.open-meteo.com/v1/forecast?latitude=${hit.latitude}&longitude=${hit.longitude}&hourly=temperature_2m,precipitation_probability&forecast_days=2&timezone=${encodeURIComponent(hit.timezone)}`,
          { signal: AbortSignal.timeout(8000) }
        )
      ).json()) as { hourly?: { time: string[]; temperature_2m: number[]; precipitation_probability: number[] } };
      // Tomorrow 08:00 local = index 24 + 8 in the hourly series.
      const i = 32;
      if (!fc.hourly || fc.hourly.time.length <= i) return null;
      return {
        temp_c: Math.round(fc.hourly.temperature_2m[i]),
        precip_prob: fc.hourly.precipitation_probability[i] ?? 0,
        label: hit.name,
      } satisfies Weather;
    });
    return value;
  } catch {
    return null; // weather is garnish, never a failure mode
  }
}

const VERDICT_SCHEMA = {
  type: "object",
  properties: { verdict_line: { type: "string", maxLength: 180 } },
  required: ["verdict_line"],
  additionalProperties: false,
} as const;

function fallbackLine(w: Wellness): string {
  if (w.patterns.length === 0) return `Wellness ${w.score}/100 — ${w.persona}. The chain is not running this life. Keep it that way.`;
  const top = w.patterns[0];
  return `Wellness ${w.score}/100 — ${w.persona}. Biggest signal: ${top.label} (${top.stat}).`;
}

export async function buildProtocol(
  w: Wellness,
  opts: { city?: string },
  budget: BudgetGuard
): Promise<{ protocol: Protocol; verdict_line: string }> {
  // GRASS — one prescription per detected pattern, worst first, max 3.
  const grass = w.patterns.slice(0, 3).map((p) => GRASS_RX[p.id](p));
  if (grass.length === 0) {
    grass.push("Nothing to fix — your break rhythm is healthy. Protect it: keep the offchain days that got you this score.");
  }

  // Weather garnish on the top grass item when a city is given.
  let weather_note: string | null = null;
  if (opts.city) {
    const wx = await morningWeather(opts.city, budget);
    if (wx) {
      weather_note =
        wx.precip_prob >= 50
          ? `${wx.label} tomorrow 8am: ${wx.temp_c}°C with ${wx.precip_prob}% rain chance — indoor plan B, or own the rain walk.`
          : `${wx.label} tomorrow 8am: ${wx.temp_c}°C, ${wx.precip_prob}% rain chance — a clean window for the morning walk.`;
    }
  }

  // FUEL — tied to the observed clock, max 3, always at least one.
  const fuel = Object.values(FUEL_RX)
    .map((f) => f(w))
    .filter((s): s is string => s !== null)
    .slice(0, 3);
  if (fuel.length === 0) fuel.push("Regular meals at regular times — the routine is already good; food at fixed anchors keeps it that way.");

  const move = {
    window: w.gym_window,
    starter: STARTERS.find((s) => s.when(w))!.starter,
  };

  // Verdict line: the one sentence on the card. Model phrases it; lint guards it;
  // deterministic fallback if the model is down or slips a banned word.
  let verdict_line = fallbackLine(w);
  try {
    const out = await structuredCall<{ verdict_line: string }>({
      label: "touchgrass-verdict",
      system:
        "You write one witty, warm one-liner for an onchain wellness report card. Observational tone, never preachy, never medical, never financial. No trade words (buy/sell/long/short/ape/moon). Mention the score naturally. Max 160 chars.",
      user: JSON.stringify({
        score: w.score,
        persona: w.persona,
        top_patterns: w.patterns.slice(0, 3).map((p) => ({ label: p.label, stat: p.stat })),
        positives: w.positives.slice(0, 2),
      }),
      schema: VERDICT_SCHEMA as unknown as Record<string, unknown>,
      budget,
      maxTokens: 300,
      effort: "low",
    });
    if (out.verdict_line && lintVerdictStrings([out.verdict_line]).ok) verdict_line = out.verdict_line;
  } catch (err) {
    console.error(`touchgrass verdict line fell back to template: ${err}`);
  }

  // Belt and braces: lint every user-facing string; drop any offender for its
  // deterministic sibling rather than shipping a banned word.
  const lint = lintVerdictStrings([...grass, ...fuel, move.starter, verdict_line]);
  if (!lint.ok) {
    console.error(`touchgrass protocol lint violations: ${JSON.stringify(lint.violations)}`);
    verdict_line = fallbackLine(w);
  }

  return { protocol: { grass, fuel, move, weather_note }, verdict_line };
}
