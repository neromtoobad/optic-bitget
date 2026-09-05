// PULSE (Binance edition) — the same short-horizon question ("is BTC higher at
// the window close?") priced by Binance Wallet's own Up/Down prediction markets
// (5m / 15m / 1h, Chainlink-resolved, USDT on BNB Chain) set against the live
// Binance spot tape: where spot already sits versus each window's start price.
// Two Binance venues, one window, the gap between them — observational only.
import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import { pmSearch, pmYesOutcome, pmUrl, type PmTopic } from "./lib/binance/web3.js";
import { spotTicker24h, num } from "./lib/binance/rest.js";
import { mcpMarketSnapshot } from "./lib/binance/mcp.js";
import type { PulseVerdict } from "./pulse.js";

const COINS = ["BTC", "ETH", "SOL"] as const;
const HORIZONS = ["5m", "15m", "1h"] as const;

export interface PulseWindow {
  horizon: string; // 5m | 15m | 1h
  slug: string;
  url: string;
  window_end_utc: string | null;
  start_price: number | null; // Chainlink start price for the window
  up_price: number | null; // Binance prediction market: price of "Up" (0-1)
  liquidity: number | null;
  spot_move_pct: number | null; // Binance spot now vs window start
  gap_pp: number | null; // up_price*100 − 50: how far the market leans, in points
  note: string;
}

export interface BinancePulseCoin {
  coin: string;
  symbol: string;
  spot_price: number | null;
  spot_source: "binance-mcp" | "binance-api" | null;
  windows: PulseWindow[];
  read: string;
}

function pickWindow(topics: PmTopic[], coin: string, horizon: string): PmTopic | null {
  const now = Date.now();
  const want = new RegExp(`^${coin} Up or Down ${horizon}$`, "i");
  return (
    topics
      .filter((t) => want.test(t.title) && (t.marketVariant ?? "") === "CRYPTO_UP_DOWN" && (!t.endDate || t.endDate > now) && (t.status ?? "") !== "RESOLVED")
      .sort((a, b) => (a.endDate ?? 0) - (b.endDate ?? 0))[0] ?? null
  );
}

export async function runPulseBinance(): Promise<PulseVerdict & { binance: BinancePulseCoin[] }> {
  const nowIso = new Date().toISOString();
  const out: BinancePulseCoin[] = [];

  for (const coin of COINS) {
    const symbol = `${coin}USDT`;
    const [topics, mcp, rest] = await Promise.all([pmSearch(`${coin} Up or Down`, 20), mcpMarketSnapshot(symbol).catch(() => null), spotTicker24h(symbol)]);
    const spot = mcp?.price ?? num(rest?.lastPrice);
    const source: BinancePulseCoin["spot_source"] = mcp?.price != null ? "binance-mcp" : spot != null ? "binance-api" : null;

    const windows: PulseWindow[] = [];
    for (const h of HORIZONS) {
      const t = pickWindow(topics ?? [], coin, h);
      if (!t) continue;
      const m = t.markets.find((x) => (x.tradingStatus ?? "OPEN") === "OPEN") ?? t.markets[0];
      const up = m ? pmYesOutcome(m) : null;
      const start = t.variantData?.startPrice ?? null;
      const move = spot != null && start ? Math.round(((spot - start) / start) * 10000) / 100 : null;
      const upPrice = up?.price ?? null;
      const gap = upPrice != null ? Math.round((upPrice * 100 - 50) * 10) / 10 : null;
      let note = "";
      if (upPrice == null || gap == null) note = "no live price on this window";
      else if (move == null) note = "window start price not published yet";
      else {
        const tape = move > 0.02 ? "above" : move < -0.02 ? "below" : "at";
        const lean = gap > 3 ? "leans up" : gap < -3 ? "leans down" : "sits near even";
        note = `spot is ${tape} the window start (${move > 0 ? "+" : ""}${move}%); the market ${lean} at ${Math.round(upPrice * 100)}% up`;
        if ((tape === "above" && gap < -3) || (tape === "below" && gap > 3)) note += " — the market disagrees with the tape";
      }
      windows.push({
        horizon: h,
        slug: t.slug,
        url: pmUrl(t.slug),
        window_end_utc: t.endDate ? new Date(t.endDate).toISOString() : null,
        start_price: start,
        up_price: upPrice,
        liquidity: m?.liquidity ?? null,
        spot_move_pct: move,
        gap_pp: gap,
        note,
      });
    }

    const w5 = windows.find((w) => w.horizon === "5m");
    const read = windows.length
      ? `${coin} ${spot != null ? `$${spot.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : "spot n/a"}: ` +
        windows.map((w) => `${w.horizon} up ${w.up_price != null ? Math.round(w.up_price * 100) + "%" : "n/a"}${w.spot_move_pct != null ? ` (tape ${w.spot_move_pct > 0 ? "+" : ""}${w.spot_move_pct}%)` : ""}`).join(" · ")
      : `${coin}: no open Up/Down window on Binance right now`;
    out.push({ coin, symbol, spot_price: spot, spot_source: source, windows, read: w5 ? `${read} — ${w5.note}` : read });
  }

  const disagreeing = out.flatMap((c) => c.windows.filter((w) => /disagrees with the tape/.test(w.note)).map((w) => ({ c, w })));
  const widest = out
    .flatMap((c) => c.windows.map((w) => ({ c, w })))
    .filter(({ w }) => w.gap_pp !== null)
    .sort((a, b) => Math.abs(b.w.gap_pp!) - Math.abs(a.w.gap_pp!))[0];
  const line = disagreeing.length
    ? `Pulse: ${disagreeing[0].c.coin} ${disagreeing[0].w.horizon} window — ${disagreeing[0].w.note}.`
    : widest
      ? `Pulse: widest lean is ${widest.c.coin} ${widest.w.horizon} at ${Math.round((widest.w.up_price ?? 0.5) * 100)}% up (${widest.w.gap_pp! > 0 ? "+" : ""}${widest.w.gap_pp}pp from even)${widest.w.spot_move_pct != null ? `, tape ${widest.w.spot_move_pct > 0 ? "+" : ""}${widest.w.spot_move_pct}% since the window opened` : ""}.`
      : "No open Up/Down windows on Binance right now — try again shortly.";

  const pulseId = widest || disagreeing.length ? randomUUID() : null;
  if (pulseId) db.prepare("INSERT INTO pulse_log (id, summary, created_at) VALUES (?,?,?)").run(pulseId, line, nowIso);
  // `coins` is the compact per-coin summary; `binance` carries the full window detail.
  return { pulse_id: pulseId, coins: out.map((c) => ({ coin: c.coin, note: c.read })), binance: out, verdict_line: line, generated_at: nowIso };
}
