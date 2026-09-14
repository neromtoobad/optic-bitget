// US cash session — deterministic, computed, never argued. NYSE regular hours
// are 09:30–16:00 America/New_York, Monday–Friday. Exchange holidays are not
// modelled yet (listed in the honest-limits section): on a holiday this reports
// "open" during those hours. The desk's whole premise lives in the gap this
// function measures — rToken perpetuals keep trading while it returns false.

const NY = "America/New_York";
const OPEN_MIN = 9 * 60 + 30;
const CLOSE_MIN = 16 * 60;

function nyParts(at: Date) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: NY, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  // Some engines print midnight as "24" with hour12:false.
  const hour = Number(get("hour")) % 24;
  return { weekday: get("weekday"), minutes: hour * 60 + Number(get("minute")) };
}

export type SessionState = "open" | "closed" | "weekend";

export function usCashSession(at: Date = new Date()): SessionState {
  const { weekday, minutes } = nyParts(at);
  if (weekday === "Sat" || weekday === "Sun") return "weekend";
  return minutes >= OPEN_MIN && minutes < CLOSE_MIN ? "open" : "closed";
}

export function usCashSessionOpen(at: Date = new Date()): boolean {
  return usCashSession(at) === "open";
}

/** Minutes until the next 09:30 ET open (0 while open). Skips the weekend; ignores holidays. */
export function minutesToUsCashOpen(at: Date = new Date()): number {
  if (usCashSessionOpen(at)) return 0;
  const step = 60 * 1000;
  // Walk forward minute by minute up to 4 days — cheap, exact, and needs no
  // DST arithmetic because Intl does the zone conversion each step.
  for (let i = 1; i <= 4 * 24 * 60; i++) {
    if (usCashSessionOpen(new Date(at.getTime() + i * step))) return i;
  }
  return -1;
}
