// PULSE — the 5-minute cross-venue read. 0.05 USDT, impulse-priced for order velocity.
//
// The core Optic thesis at its fastest cadence: the SAME short-horizon question
// ("is this coin higher at the window close?") is priced on TWO live venues —
//   · OKX event contracts  (v5 EVENTS, <COIN>-UPDOWN-5MIN, USDT books)
//   · Polymarket 5-min Up/Down (Chainlink-resolved, USDC books)
// Pulse reports both prices and the divergence in points, per coin. Where the
// venues disagree on a 5-minute window, that gap IS the read. Observational
// only — prices, windows, and the spread between them; never an instruction.
import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import { isCliEntry } from "./fixtures.js";
import { listEventTickers, listSeriesInstruments, type RawTicker } from "./ticket/events.js";
import { resolveUpdown } from "./ticket/updown.js";
import { config } from "./config.js";

const COINS = ["BTC", "ETH", "SOL"] as const; // covered by BOTH venues today

export interface PulseCoin {
  coin: string;
  okx: { inst_id: string; window_end_utc: string | null; bid: number | null; ask: number | null; mid: number | null } | null;
  polymarket: { condition_id: string; window_end_utc: string; up_price: number | null; liquidity: number } | null;
  divergence_pp: number | null; // OKX mid − Polymarket up, in probability points
  note: string;
}

export interface PulseVerdict {
  pulse_id: string | null;
  coins: PulseCoin[];
  verdict_line: string;
  generated_at: string;
}

db.exec(`CREATE TABLE IF NOT EXISTS pulse_log (
  id         TEXT PRIMARY KEY,
  summary    TEXT NOT NULL,
  paid_tx    TEXT,
  created_at TEXT NOT NULL
)`);

/** Settlement middleware attaches the on-chain fee tx to the pulse record. */
export function attachPulseTx(id: string, tx: string): void {
  db.prepare("UPDATE pulse_log SET paid_tx = ? WHERE id = ?").run(tx, id);
}

async function okxLeg(tickers: RawTicker[], coin: string): Promise<PulseCoin["okx"]> {
  // authoritative expiry comes from the instruments endpoint (instId times are UTC+8)
  const instruments = await listSeriesInstruments(`${coin}-UPDOWN-5MIN`);
  if (!instruments?.length) return null;
  const now = Date.now();
  const nearest = instruments
    .filter((i) => i.state === "live" && Number(i.expTime) > now)
    .sort((a, b) => Number(a.expTime) - Number(b.expTime))[0];
  if (!nearest) return null;
  const t = tickers.find((x) => x.instId === nearest.instId);
  const bid = t?.bidPx ? Number(t.bidPx) : null;
  const ask = t?.askPx ? Number(t.askPx) : null;
  const mid = bid !== null && ask !== null ? Number(((bid + ask) / 2).toFixed(3)) : (bid ?? ask);
  return {
    inst_id: nearest.instId,
    window_end_utc: new Date(Number(nearest.expTime)).toISOString(),
    bid,
    ask,
    mid,
  };
}

export async function runPulse(): Promise<PulseVerdict> {
  if (config.exchange === "cex") return (await import("./pulse-cex.js")).runPulseCEX();
  const nowIso = new Date().toISOString();
  const tickers = await listEventTickers();
  const coins: PulseCoin[] = [];

  for (const coin of COINS) {
    const okx = tickers ? await okxLeg(tickers, coin) : null;
    const pm = await resolveUpdown(coin);
    const polymarket = pm
      ? { condition_id: pm.condition_id, window_end_utc: pm.window_end_utc, up_price: pm.up_price, liquidity: pm.liquidity }
      : null;

    let divergence: number | null = null;
    let note = "";
    if (okx?.mid != null && polymarket?.up_price != null) {
      // a divergence number is only honest when both venues price the SAME window
      const aligned =
        okx.window_end_utc !== null &&
        Math.abs(Date.parse(okx.window_end_utc) - Date.parse(polymarket.window_end_utc)) <= 120_000;
      if (aligned) {
        divergence = Number(((okx.mid - polymarket.up_price) * 100).toFixed(1));
        note =
          divergence === 0
            ? "venues agree on this window"
            : `venues ${Math.abs(divergence) >= 3 ? "clearly " : ""}disagree on the same window`;
      } else {
        note = "venue windows are offset — both prices shown, no comparable divergence this round";
      }
    } else if (okx && !polymarket) note = "only OKX is pricing this window right now";
    else if (!okx && polymarket) note = "only Polymarket is pricing this window right now";
    else note = "neither venue has an open window — check back in minutes";

    coins.push({ coin, okx, polymarket, divergence_pp: divergence, note });
  }

  const priced = coins.filter((c) => c.divergence_pp !== null);
  if (!priced.length && coins.every((c) => !c.okx && !c.polymarket)) {
    return { pulse_id: null, coins, verdict_line: "No open 5-minute windows on either venue right now — try again shortly.", generated_at: nowIso };
  }

  const widest = priced.sort((a, b) => Math.abs(b.divergence_pp!) - Math.abs(a.divergence_pp!))[0];
  const bothButOffset = coins.some((c) => c.okx && c.polymarket && c.divergence_pp === null);
  const line = widest
    ? `Pulse: widest 5-minute divergence is ${widest.coin} at ${Math.abs(widest.divergence_pp!)}pp ` +
      `(OKX ${widest.okx!.mid} vs Polymarket ${widest.polymarket!.up_price}).`
    : bothButOffset
      ? "Pulse: both venues priced, but windows are offset this round — prices reported, no comparable divergence."
      : `Pulse: ${coins.filter((c) => c.okx || c.polymarket).length} coin(s) priced on one venue only this window.`;

  const pulseId = randomUUID();
  db.prepare("INSERT INTO pulse_log (id, summary, created_at) VALUES (?,?,?)").run(pulseId, line, nowIso);
  return { pulse_id: pulseId, coins, verdict_line: line, generated_at: nowIso };
}

// CLI: npm run pulse
if (isCliEntry(import.meta.url)) {
  runPulse().then((v) => console.log(JSON.stringify(v, null, 2)));
}
