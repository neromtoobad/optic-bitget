import type { PredictionVenue } from "../types.js";
import type { BudgetGuard } from "../pipeline/budget.js";
import type { EvidenceRow, EvidenceStatus, EvidenceTable, Coverage, GapStats } from "./types.js";
import { findBitgetFuture } from "../lenses/stocks.js";
import { cashQuote, type CashQuote } from "../lib/yahoo.js";
import { resolveRwaContract, historyCandles, historyFundRate, parseCandle, num as bgNum } from "../lib/bitget/rest.js";
import type { StockTokenized } from "../types.js";
import { usCashSession, minutesToUsCashOpen } from "../lib/bitget/session.js";
import { callSignalTool } from "../lib/bitget/signal.js";
import { researchStock } from "../lenses/research.js";
import { predictionLens } from "../lenses/prediction.js";

// EVIDENCE — gather every market that prices the company into one table.
// Each source is fetched independently, bounded in time, and classified as
// ok / empty / error. Nothing here throws through the desk: a dead upstream
// becomes a row with status "error" and a note, and the coverage ratio drops.
// The debate cites row ids; the judge strikes citations to rows that aren't ok.

// A third-party tool that hasn't answered in this long is reported as an error
// and the desk moves on — the trader is waiting, and coverage is honest about it.
const SIGNAL_TIMEOUT_MS = 25_000;
// Third-party payloads are stored opaquely; cap them so the debate prompt
// stays within budget. Our own legs are typed and small.
const MAX_VALUE_CHARS = 1_800;

const now = () => new Date().toISOString();

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T | null> {
  return Promise.race([
    p.catch((err) => {
      console.error(`evidence ${label}: ${err}`);
      return null as T | null;
    }),
    new Promise<null>((r) => setTimeout(() => r(null), ms)),
  ]);
}

/**
 * bitget-signal reports upstream failures inside a 200: `{"error": ""}`, or a
 * per-feed list where every item is `{feed, error, items: []}`, or an MCP
 * isError block (which the client turns into a thrown error → null here).
 */
export function classifySignal(payload: unknown): { status: EvidenceStatus; note?: string } {
  if (payload === null || payload === undefined) return { status: "error", note: "tool returned no result" };
  if (typeof payload === "string") return payload.trim() ? { status: "ok" } : { status: "empty" };
  if (Array.isArray(payload)) {
    if (payload.length === 0) return { status: "empty" };
    const allFailed = payload.every((x) => x && typeof x === "object" && "error" in (x as object) && (!("items" in (x as object)) || ((x as { items?: unknown[] }).items ?? []).length === 0));
    return allFailed ? { status: "error", note: "every upstream feed failed" } : { status: "ok" };
  }
  if (typeof payload === "object") {
    const rec = payload as Record<string, unknown>;
    const keys = Object.keys(rec);
    const errKey = keys.find((k) => /error/i.test(k));
    if (errKey && keys.length <= 2) return { status: "error", note: `upstream error: ${String(rec[errKey] || "(blank)")}` };
    if (keys.length === 0) return { status: "empty" };
    // A snapshot whose every field is itself `{error: …}` (rates_yields when FRED
    // is down) is a failure wearing the shape of a result.
    const isErrObj = (v: unknown) => !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length <= 2 && Object.keys(v as object).some((k) => /error/i.test(k));
    if (keys.length > 0 && keys.every((k) => isErrObj(rec[k]))) return { status: "error", note: "every field reported an upstream error" };
    return { status: "ok" };
  }
  return { status: "ok" };
}

/** Bound an opaque payload for the prompt; note when it was cut. */
function compact(value: unknown): { value: unknown; note?: string } {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  if (s.length <= MAX_VALUE_CHARS) return { value };
  return { value: s.slice(0, MAX_VALUE_CHARS) + "…", note: `truncated from ${s.length} chars` };
}

function row(id: string, source: string, label: string, computed: boolean, status: EvidenceStatus, value: unknown, note?: string): EvidenceRow {
  return { id, source, label, computed, status, fetched_at: now(), value, ...(note ? { note } : {}) };
}

/** A bitget-signal tool as one evidence row. */
async function signalRow(id: string, label: string, tool: string, args: Record<string, unknown>, budget: BudgetGuard): Promise<EvidenceRow> {
  const payload = await withTimeout(callSignalTool(tool, args, { budget }), SIGNAL_TIMEOUT_MS, `${tool}:${id}`);
  const c = classifySignal(payload);
  if (c.status !== "ok") return row(id, `bitget-signal:${tool}`, label, true, c.status, null, c.note ?? (payload === null ? "no answer within the time limit" : undefined));
  const k = compact(payload);
  return row(id, `bitget-signal:${tool}`, label, true, "ok", k.value, k.note);
}

function coverageOf(rows: EvidenceRow[]): Coverage {
  const c: Coverage = { total: rows.length, ok: 0, empty: 0, error: 0, skipped: 0, computed_ok: 0, ratio: 0 };
  for (const r of rows) {
    c[r.status]++;
    if (r.status === "ok" && r.computed) c.computed_ok++;
  }
  c.ratio = c.total ? Math.round((c.ok / c.total) * 100) / 100 : 0;
  return c;
}

const round = (x: number | null | undefined, p = 3): number | null => (x === null || x === undefined ? null : Math.round(x * 10 ** p) / 10 ** p);

/**
 * Build the evidence table for a resolved company. `ticker`/`company` come from
 * the caller (the desk resolves them once, up front); this function never
 * calls a model except through the research lens, which is marked argued.
 */
export async function gatherEvidence(thesis: string, ticker: string, company: string, budget: BudgetGuard, opts: { at?: Date } = {}): Promise<EvidenceTable> {
  const t0 = Date.now();
  const mark = (stage: string) => console.error(`  [evidence ${ticker}] ${stage} +${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const at = opts.at ?? null;
  const session = usCashSession(at ?? undefined);
  const minutesToOpen = minutesToUsCashOpen(at ?? undefined);

  // Our own legs first — they decide whether there is a perp to talk about at all.
  // A replay rebuilds both legs as of `at` from archives; a live read takes the tape.
  const [perp, cash] = at
    ? await Promise.all([perpAsOf(ticker, at, budget).catch(() => null), cashAsOf(ticker, at, budget).catch(() => null)])
    : await Promise.all([findBitgetFuture(ticker, budget).catch(() => null), cashQuote(ticker, budget).catch(() => null)]);
  const symbol = perp?.symbol ?? null;
  mark(`own legs (perp=${symbol ?? "none"}, cash=${cash ? "ok" : "none"})`);

  const rows: EvidenceRow[] = [];
  rows.push(
    perp
      ? row("perp", "bitget-rest", `Bitget rToken perpetual ${perp.symbol}`, true, "ok", perp)
      : row("perp", "bitget-rest", "Bitget rToken perpetual", true, "empty", null, `Bitget lists no rToken perpetual for ${ticker}`)
  );
  rows.push(
    cash
      ? row("cash", "yahoo", `${cash.name ?? ticker} cash market (${cash.exchange ?? "US"})`, true, "ok", { ...cash, closes: cash.closes.slice(-10) })
      : row("cash", "yahoo", "cash market", true, "error", null, "no cash quote available")
  );
  rows.push(row("session", "clock", "US cash session", true, "ok", { state: session, minutes_to_open: minutesToOpen, checked_at: now(), holidays_modelled: false }));

  // The gap — arithmetic over the two legs. Computed, and only when both exist.
  let gap: GapStats | null = null;
  if (perp || cash) {
    const perpPrice = perp?.price ?? null;
    const cashPrice = cash?.price ?? null;
    gap = {
      session,
      minutes_to_us_open: minutesToOpen,
      perp_price: perpPrice,
      cash_price: cashPrice,
      cash_previous_close: cash?.previous_close ?? null,
      perp_vs_cash_pct: perpPrice !== null && cashPrice ? round(((perpPrice - cashPrice) / cashPrice) * 100) : null,
      basis_pct: perp?.basis_pct ?? null,
      funding_rate: perp?.funding_rate ?? null,
      funding_annualized_pct: perp?.funding_annualized_pct ?? null,
      open_interest_usdt: perp?.open_interest_usdt ?? null,
      volume_24h_usdt: perp?.volume_24h_usdt ?? null,
      spread_bps: perp?.spread_bps ?? null,
    };
    rows.push(row("gap", "computed", "perp vs cash gap", true, "ok", gap));
  }

  // Everything else in parallel, each bounded. bitget-signal is the perception
  // layer the organisers point at; research and prediction are Optic's own.
  const signalSymbol = symbol ?? `${ticker}USDT`;
  if (at) {
    // Replay: no third-party row can be rebuilt as of a past moment without
    // leaking what came after. They are SKIPPED — visibly — and coverage drops.
    const skip = (id: string, label: string, source: string, computed: boolean) => row(id, source, label, computed, "skipped", null, "not reconstructable as of a past timestamp");
    rows.push(
      skip("crosscheck", `${signalSymbol} 24h ticker via bitget-signal`, "bitget-signal:crypto_derivatives", true),
      skip("news", `news mentioning ${company}`, "bitget-signal:tradfi_news", true),
      skip("earnings", `${ticker} company profile / earnings calendar`, "bitget-signal:tradfi_news", true),
      skip("positioning", `${signalSymbol} long/short positioning`, "bitget-signal:derivatives_sentiment", true),
      skip("technicals", `${signalSymbol} technical read (1h)`, "bitget-signal:technical_analysis", true),
      skip("macro", "rates snapshot", "bitget-signal:rates_yields", true),
      skip("fear_greed", "crypto fear & greed", "bitget-signal:sentiment_index", true),
      skip("research", "web-sourced equity research brief", "research", false),
      skip("prediction", `prediction markets on ${company}`, "polymarket", true)
    );
    mark("replay: third-party legs skipped");
    return { thesis, ticker, company, symbol, rows, coverage: coverageOf(rows), gap, gathered_at: now(), perp, cash, prediction: null };
  }
  const [crosscheck, news, earnings, positioning, technicals, macro, fearGreed, research, prediction] = await Promise.all([
    // A second, independent reading of the same perpetual through Bitget's
    // Skill service — two paths to one number is how a computed row earns trust.
    signalRow("crosscheck", `${signalSymbol} 24h ticker via bitget-signal`, "crypto_derivatives", { action: "ticker_24h", symbol: signalSymbol }, budget),
    signalRow("news", `news mentioning ${company}`, "tradfi_news", { action: "news", symbol: ticker, limit: 6 }, budget),
    signalRow("earnings", `${ticker} company profile / earnings calendar`, "tradfi_news", { action: "company", symbol: ticker }, budget),
    signalRow("positioning", `${signalSymbol} long/short positioning`, "derivatives_sentiment", { action: "long_short", symbol: signalSymbol, period: "4h" }, budget),
    signalRow("technicals", `${signalSymbol} technical read (1h)`, "technical_analysis", { action: "full_analysis", symbol: signalSymbol, timeframe: "1h" }, budget),
    signalRow("macro", "rates snapshot", "rates_yields", { action: "rates_snapshot" }, budget),
    signalRow("fear_greed", "crypto fear & greed", "sentiment_index", { action: "current" }, budget),
    withTimeout(researchStock(`${ticker} ${company} stock`, budget), 90_000, "research"),
    withTimeout(predictionLens.read({ type: "narrative", name: company }, budget), 30_000, "prediction"),
  ]);
  rows.push(crosscheck, news, earnings, positioning, technicals, macro, fearGreed);
  mark("third-party legs");

  // Research is a model's web-sourced brief: useful, cited, but ARGUED — the
  // card must not present it as data. Sources ride along so the trader can check.
  rows.push(
    research
      ? row("research", "research", "web-sourced equity research brief", false, "ok", { brief: research.brief, sources: research.sources })
      : row("research", "research", "web-sourced equity research brief", false, "error", null, "no sourced brief available")
  );

  const pred: PredictionVenue | null = prediction && prediction.markets?.length ? prediction : null;
  rows.push(
    pred
      ? row("prediction", "polymarket", `prediction markets on ${company}`, true, "ok", pred.markets.slice(0, 5).map((m) => ({ q: m.question, yes: m.yes_price, chg24h: m.yes_chg_24h, vol: m.volume })))
      : row("prediction", "polymarket", `prediction markets on ${company}`, true, "empty", null, "no prediction market prices this company")
  );

  return {
    thesis,
    ticker,
    company,
    symbol,
    rows,
    coverage: coverageOf(rows),
    gap,
    gathered_at: now(),
    perp,
    cash,
    prediction: pred,
  };
}

// ── replay: rebuild our own legs as of a past moment ─────────────────

const roundTo = (x: number | null, p = 2): number | null => (x === null ? null : Math.round(x * 10 ** p) / 10 ** p);

/** The perp as of `at`: the last completed hourly bar at or before it, and the funding rate then in force. */
async function perpAsOf(ticker: string, at: Date, budget: BudgetGuard): Promise<StockTokenized | null> {
  const contract = await resolveRwaContract(ticker, budget);
  if (!contract) return null;
  const atMs = at.getTime();
  const [bars, funding] = await Promise.all([historyCandles(contract.symbol, "1H", 48, atMs, budget), historyFundRate(contract.symbol, budget, 100)]);
  const parsed = (bars ?? []).map(parseCandle).filter((b): b is NonNullable<typeof b> => b !== null && b.ts <= atMs);
  const bar = parsed[parsed.length - 1];
  if (!bar) return null;
  const prior = parsed.find((b) => b.ts <= atMs - 24 * 3600_000) ?? parsed[0];
  // Funding settled at or before `at` — the most recent settlement is the rate that was in force.
  const settled = (funding ?? []).map((f) => ({ rate: bgNum(f.fundingRate), t: bgNum(f.fundingTime) })).filter((f) => f.t !== null && f.t <= atMs && f.rate !== null);
  const rate = settled.length ? settled.reduce((a, b) => (b.t! > a.t! ? b : a)).rate : null;
  const intervalH = bgNum(contract.fundInterval) ?? 8;
  return {
    symbol: contract.symbol,
    venue: "perpetual",
    chain: "bitget-futures",
    address: "",
    price: roundTo(bar.close),
    chg_24h: prior && prior.close ? roundTo(((bar.close - prior.close) / prior.close) * 100) : null,
    liquidity: null,
    holders: null,
    mark_price: null,
    index_price: null,
    basis_pct: null, // mark/index are not archived — a replay cannot claim a basis it never saw
    funding_rate: rate,
    funding_interval_h: intervalH,
    funding_annualized_pct: rate === null ? null : roundTo(rate * (24 / intervalH) * 365 * 100, 2),
    open_interest: null,
    open_interest_usdt: null,
    volume_24h_usdt: roundTo(parsed.filter((b) => b.ts > atMs - 24 * 3600_000).reduce((s, b) => s + b.quoteVolume, 0), 0),
    spread_bps: null,
    us_session_open: usCashSession(at) === "open",
  };
}

/** The cash market as of `at`: that day's close (or the prior session's, if `at` is before the close) from the daily series. */
async function cashAsOf(ticker: string, at: Date, budget: BudgetGuard): Promise<CashQuote | null> {
  const q = await cashQuote(ticker, budget, "1y");
  if (!q) return null;
  const day = at.toISOString().slice(0, 10);
  // Daily bars are end-of-day: a bar dated `day` is only known once that session
  // has closed. Before the close, the last KNOWN print is the prior session's.
  const closedToday = usCashSession(at) !== "open" && at.getUTCHours() >= 20; // ≥ 16:00 ET, roughly
  const known = q.closes.filter((c) => (closedToday ? c.date <= day : c.date < day));
  const last = known[known.length - 1];
  const prev = known[known.length - 2];
  if (!last) return null;
  return {
    ...q,
    price: last.close,
    previous_close: prev?.close ?? null,
    chg_pct: prev?.close ? roundTo(((last.close - prev.close) / prev.close) * 100) : null,
    day_high: null,
    day_low: null,
    volume: null,
    as_of: `${last.date}T20:00:00.000Z`,
    closes: known.slice(-10),
  };
}
