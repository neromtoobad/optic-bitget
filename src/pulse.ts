// PULSE — the short-horizon read. 0.05 USDT, impulse-priced for order velocity.
//
// The core Optic thesis at its fastest cadence: the SAME question ("is this coin
// higher at the window close?") priced on Binance Wallet's Up/Down prediction
// markets and set against the live Binance spot tape. Where the priced lean and
// the tape disagree, that gap IS the read. Observational only — prices, windows,
// and the spread between them; never an instruction.
import { db } from "./db.js";
import { isCliEntry } from "./fixtures.js";

export interface PulseCoin {
  coin: string;
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

export async function runPulse(): Promise<PulseVerdict> {
  return (await import("./pulse-binance.js")).runPulseBinance();
}

if (isCliEntry(import.meta.url)) {
  console.log(JSON.stringify(await runPulse(), null, 2));
}
