import type { PredictionVenue, StockTokenized } from "../types.js";
import type { CashQuote } from "../lib/yahoo.js";
import type { SessionState } from "../lib/bitget/session.js";

// THE DESK — a research workbench for Bitget's rToken US-stock perpetuals.
// The trader types a thesis; the desk gathers every market that prices the
// company into an EVIDENCE TABLE, has two analysts argue the thesis against
// that table, and a judge scores what survived. Two invariants run through
// every type here:
//   1. `computed` rows come from code (exchange data, the clock, arithmetic).
//      Argued rows come from a model. The card labels which is which.
//   2. Every claim in the debate cites an evidence row id. A claim with no
//      citation, or citing a row that isn't `ok`, is struck by the judge.
// Missing evidence lowers CONFIDENCE, never the score — absence is coverage,
// not a verdict.

export type EvidenceStatus = "ok" | "empty" | "error" | "skipped";

export interface EvidenceRow {
  /** Short stable id the debate cites, e.g. "perp", "cash", "funding", "news". */
  id: string;
  /** Where it came from: "bitget-rest", "yahoo", "clock", "bitget-signal:tradfi_news", "research", "polymarket". */
  source: string;
  label: string;
  /** True when produced by code/data; false when a model wrote it (research briefs). */
  computed: boolean;
  status: EvidenceStatus;
  fetched_at: string;
  /** The payload the debate may cite. Opaque for third-party tools; typed for our own legs. */
  value: unknown;
  /** Why a row is empty/error/skipped, or that a large payload was truncated. */
  note?: string;
}

export interface Coverage {
  total: number;
  ok: number;
  empty: number;
  error: number;
  skipped: number;
  /** Computed rows that came back ok — the floor the verdict can stand on without any model. */
  computed_ok: number;
  /** 0–1: ok / total. Drives the confidence cap, never the score. */
  ratio: number;
}

/** Deterministic numbers derived from the perp and cash legs — the gap itself. */
export interface GapStats {
  session: SessionState;
  minutes_to_us_open: number;
  perp_price: number | null;
  cash_price: number | null; // regular-session last (stale while the cash market is closed — that staleness IS the gap)
  cash_previous_close: number | null;
  /** (perp − cash last) / cash last × 100 — while closed, how far the perp has drifted from the last cash print. */
  perp_vs_cash_pct: number | null;
  /** (mark − index) / index × 100 — the exchange's own measure of perp vs underlying. */
  basis_pct: number | null;
  funding_rate: number | null;
  funding_annualized_pct: number | null;
  open_interest_usdt: number | null;
  volume_24h_usdt: number | null;
  spread_bps: number | null;
}

export interface EvidenceTable {
  thesis: string;
  ticker: string;
  company: string;
  /** The rToken perpetual symbol, e.g. NVDAUSDT, or null when Bitget lists none. */
  symbol: string | null;
  rows: EvidenceRow[];
  coverage: Coverage;
  gap: GapStats | null;
  gathered_at: string;
  /** Typed views of our own legs, for the card; the rows carry the same data for citation. */
  perp: StockTokenized | null;
  cash: CashQuote | null;
  prediction: PredictionVenue | null;
}

export type DebateRole = "bull" | "bear";

export interface DebateTurn {
  role: DebateRole;
  round: number;
  /** P(the thesis holds — right, and not already in the price) in [0,1]; both sides report in this space. */
  probability: number;
  confidence: number;
  reasoning: string;
  message_to_peer: string;
  /** Evidence row ids this turn relies on. */
  citations: string[];
  /** Citations the judge struck: unknown ids, or rows that were not ok. */
  struck: string[];
}

export type JudgeCall = "holds" | "priced_in" | "contested" | "insufficient_evidence";

export interface JudgeVerdict {
  call: JudgeCall;
  /** Structured probability that the thesis holds, capped to [0.10, 0.90]. */
  p_thesis_holds: number;
  /** [0,1] after the coverage cap. */
  confidence: number;
  what_is_priced_in: string;
  /** The one surviving attack that would make the trader wrong. */
  strongest_attack: string;
  reasoning: string;
  /** Citations the judge relied on. */
  citations: string[];
  /** Every citation struck across the transcript, with the reason. */
  struck: Array<{ role: DebateRole; round: number; id: string; reason: string }>;
  /** Judge samples that were aggregated (median) into this verdict. */
  samples: number;
}

export interface DeskVerdict {
  query: string;
  resolved: { type: "desk"; name: string };
  evidence: EvidenceTable;
  /** Empty when the desk found nothing contested and skipped the debate. */
  transcript: DebateTurn[];
  debated: boolean;
  judge: JudgeVerdict | null;
  /** Set when the table was rebuilt as of a past moment (a judge-built scenario). Replays are never ledgered. */
  replay: { at: string } | null;
  /** Set when the thesis was too ambiguous to judge — the desk asked one question instead of spending. */
  clarifying_question: string | null;
  /** How the desk read the thesis, for the scoreboard's grading rule. */
  read: { direction: "up" | "down" | "neutral"; horizon_hours: number } | null;
  /** One observational sentence — lint-clean, never a trade instruction. */
  verdict_line: string;
  /** What the LLM was and wasn't used for on this read — the form asks; the card shows. */
  llm_role: string;
  generated_at: string;
  card_url: string | null;
  card_pending?: boolean;
}
