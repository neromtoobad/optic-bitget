import { structuredCall } from "../lib/anthropic.js";
import { lintVerdictStrings } from "../lint.js";
import { BudgetGuard } from "../pipeline/budget.js";
import { isCliEntry } from "../fixtures.js";
import { gatherEvidence } from "./evidence.js";
import { rwaContracts } from "../lib/bitget/rest.js";
import { config } from "../config.js";
import { runDebate } from "./debate.js";
import { runJudge } from "./judge.js";
import type { DeskVerdict, EvidenceTable, JudgeVerdict } from "./types.js";

// THE DESK RUNNER — thesis in, cited verdict out.
//   1. Read the thesis (one small model call): company, direction, horizon,
//      and whether it is too ambiguous to judge — in which case the desk asks
//      ONE question and spends nothing else.
//   2. Gather the evidence table (code + bounded third-party fetches).
//   3. Decide whether there is anything to debate. No perp listed → nothing the
//      desk can say about Bitget. Markets in agreement with nothing contested →
//      say so and stop (the boring case is a required fixture). Too little
//      evidence → abstain.
//   4. Debate, judge, lint, and hand back the verdict — never an order.

const READ_SCHEMA = {
  type: "object",
  properties: {
    ticker: { type: "string", description: "The US-listed stock or index ticker in CAPS, no $ (e.g. NVDA, AAPL, SPY). Infer from a company name if needed. Empty string if none." },
    company: { type: "string", description: "The company or index name." },
    is_stock: { type: "boolean", description: "true only if the thesis is about a publicly-traded company, ETF or index." },
    direction: { type: "string", enum: ["up", "down", "neutral"], description: "Which way the thesis expects the price to go. neutral if it is a question rather than a directional view." },
    horizon_hours: { type: "number", description: "How long the thesis plays out, in hours. Earnings 'this week' ≈ 96; 'overnight' ≈ 16; 'next month' ≈ 720. 48 if unstated." },
    clarifying_question: { type: "string", description: "Empty string if the thesis is judgeable as written. Otherwise ONE short question whose answer is needed before any evidence is worth gathering (e.g. which company, which direction, what horizon)." },
  },
  required: ["ticker", "company", "is_stock", "direction", "horizon_hours", "clarifying_question"],
  additionalProperties: false,
} as const;

const now = () => new Date().toISOString();

// "Nothing contested": the perp sits on its underlying, funding is flat, and no
// other market is pricing the company. Thresholds are deliberately tight — the
// desk should skip the debate only when there is genuinely nothing to argue.
const AGREE = { basis_pct: 0.05, funding_annualized_pct: 5, perp_vs_cash_pct: 0.25 };

function nothingContested(ev: EvidenceTable): string | null {
  const g = ev.gap;
  if (!g || !ev.perp) return null;
  const quiet =
    Math.abs(g.basis_pct ?? 0) <= AGREE.basis_pct &&
    Math.abs(g.funding_annualized_pct ?? 0) <= AGREE.funding_annualized_pct &&
    Math.abs(g.perp_vs_cash_pct ?? 0) <= AGREE.perp_vs_cash_pct;
  const otherMarkets = ev.rows.some((r) => ["prediction", "news", "positioning"].includes(r.id) && r.status === "ok");
  if (quiet && !otherMarkets) {
    return `${ev.ticker}: the perpetual sits on its underlying (basis ${g.basis_pct ?? 0}%, funding ${g.funding_annualized_pct ?? 0}%/yr, ${g.perp_vs_cash_pct ?? 0}% from the last cash print) and no other market is pricing the company — nothing here disagrees with the cash market.`;
  }
  return null;
}

function base(query: string, name: string, ev: EvidenceTable | null): Omit<DeskVerdict, "verdict_line" | "llm_role"> {
  return {
    query,
    resolved: { type: "desk", name },
    evidence: ev ?? emptyTable(query, name),
    transcript: [],
    debated: false,
    judge: null,
    replay: null,
    clarifying_question: null,
    read: null,
    generated_at: now(),
    card_url: null,
  };
}

function emptyTable(thesis: string, name: string): EvidenceTable {
  return { thesis, ticker: "", company: name, symbol: null, rows: [], coverage: { total: 0, ok: 0, empty: 0, error: 0, skipped: 0, computed_ok: 0, ratio: 0 }, gap: null, analogs: null, gathered_at: now(), perp: null, cash: null, prediction: null };
}

const callWord: Record<JudgeVerdict["call"], string> = {
  holds: "the thesis survived the table",
  priced_in: "the markets already reflect this",
  contested: "the table cannot settle this",
  insufficient_evidence: "the evidence to judge this is missing",
};

type Read = { ticker: string; company: string; is_stock: boolean; direction: "up" | "down" | "neutral"; horizon_hours: number; clarifying_question: string };

/**
 * Deterministic thesis reader — no model. The ticker is any word that names a
 * live rToken perpetual on Bitget; direction and horizon come from the wording.
 * Runs first on every read (cheap, exact when the trader typed a ticker), and
 * is the ONLY reader when no LLM key is configured: the desk then returns the
 * computed table with no verdict rather than failing.
 */
export async function readThesisDeterministic(thesis: string, budget: BudgetGuard): Promise<Read | null> {
  const contracts = await rwaContracts(budget).catch(() => []);
  const bases = new Map(contracts.map((c) => [c.baseCoin.toUpperCase(), c]));
  const words = thesis.replace(/[^A-Za-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  const hit = words.map((w) => w.toUpperCase()).find((w) => /^[A-Z0-9]{1,8}$/.test(w) && bases.has(w));
  if (!hit) return null;
  const t = thesis.toLowerCase();
  const up = /\b(long|bull|bullish|up|higher|rally|rip|calls?|breakout|beat)\b/.test(t);
  const down = /\b(short|bear|bearish|down|lower|fade|dump|puts?|sell-?off|miss)\b/.test(t);
  const direction: Read["direction"] = up && !down ? "up" : down && !up ? "down" : "neutral";
  const horizon = /earnings|this week/.test(t) ? 96 : /overnight|open|tonight|tomorrow/.test(t) ? 16 : /month/.test(t) ? 720 : /week/.test(t) ? 168 : 48;
  return { ticker: hit, company: hit, is_stock: true, direction, horizon_hours: horizon, clarifying_question: "" };
}

const llmAvailable = () => !!(config.veniceApiKey || config.anthropicApiKey || (config.openaiCompat.baseUrl && config.openaiCompat.apiKey));

export async function runDesk(query: string, budget: BudgetGuard, opts: { at?: Date } = {}): Promise<DeskVerdict> {
  const thesis = query.trim();
  const replay = opts.at ? { at: opts.at.toISOString() } : null;
  const exact = await readThesisDeterministic(thesis, budget);
  const modelRead = llmAvailable()
    ? await structuredCall<Read>({
        label: "desk_read",
        system: "Read a trader's thesis about a US stock. Identify the company, the direction it expects, and the horizon. If — and only if — the thesis cannot be judged as written, write one clarifying question.",
        user: thesis,
        schema: READ_SCHEMA as unknown as Record<string, unknown>,
        budget,
        maxTokens: 160,
        effort: "low",
      }).catch((err): Read | null => {
        console.error(`desk_read: ${err}`);
        return null;
      })
    : null;
  // A ticker the trader typed outranks a model's guess; the model adds the
  // company name, catches ambiguity, and covers company-name-only theses.
  const read: Read = modelRead
    ? { ...modelRead, ticker: exact?.ticker ?? modelRead.ticker, is_stock: modelRead.is_stock || !!exact, clarifying_question: exact ? "" : modelRead.clarifying_question }
    : exact ?? { ticker: "", company: "", is_stock: false, direction: "neutral", horizon_hours: 48, clarifying_question: "" };

  if (!llmAvailable() && !exact) {
    return {
      ...base(thesis, thesis, null),
      replay,
      verdict_line: "No model is configured and no Bitget-listed ticker appears in the thesis — type the ticker (e.g. NVDA) and the desk will still compute the evidence table.",
      llm_role: "No LLM key configured. Deterministic reader found no ticker; nothing gathered.",
    };
  }

  const ticker = (read.ticker ?? "").toUpperCase().replace(/[^A-Z0-9.]/g, "");
  const company = (read.company ?? "").trim() || ticker;

  if (read.clarifying_question?.trim()) {
    return {
      ...base(thesis, company || thesis, null),
      clarifying_question: read.clarifying_question.trim(),
      verdict_line: "One question before the desk spends anything on this.",
      llm_role: "Read the thesis (1 small call); found it ambiguous; asked instead of guessing. No evidence gathered, no debate.",
    };
  }
  if (!read.is_stock || !ticker) {
    return {
      ...base(thesis, thesis, null),
      verdict_line: `"${thesis}" doesn't resolve to a US stock or index — try a ticker or company (e.g. NVDA, Apple, SPY).`,
      llm_role: "Read the thesis (1 small call). Not a stock; no evidence gathered, no debate.",
    };
  }

  const ev = await gatherEvidence(thesis, ticker, company, budget, { ...(opts.at ? { at: opts.at } : {}), direction: read.direction ?? "neutral", horizonHours: Number.isFinite(read.horizon_hours) && read.horizon_hours > 0 ? read.horizon_hours : 48 });
  const readMeta = { direction: read.direction ?? "neutral", horizon_hours: Number.isFinite(read.horizon_hours) && read.horizon_hours > 0 ? read.horizon_hours : 48 } as const;
  const gatheredNote = `Gathered ${ev.coverage.ok}/${ev.coverage.total} evidence rows (${ev.coverage.computed_ok} computed by code).`;

  if (!ev.perp) {
    return {
      ...base(thesis, company, ev),
      replay,
      read: readMeta,
      verdict_line: `${ticker}: Bitget lists no rToken perpetual for this name — the desk reads Bitget's tokenized US stocks, and this isn't one yet.`,
      llm_role: `Read the thesis (1 small call). ${gatheredNote} No Bitget listing; no debate.`,
    };
  }

  // Degraded mode: no model at all. The computed legs still stand; the desk
  // hands them over with no verdict rather than pretending to have one.
  if (!llmAvailable()) {
    return {
      ...base(thesis, company, ev),
      replay,
      read: readMeta,
      verdict_line: ev.analogs?.base_rate_p != null
        ? `${ticker}: base rate from ${ev.analogs.n} comparable ${ev.analogs.kind} windows — P(holds) ${Math.round(ev.analogs.base_rate_p * 100)}%, median move ${ev.analogs.median_move_pct}%, worst against ${ev.analogs.worst_against_pct}%. No model configured: computed only, nothing argued.`
        : `${ticker}: computed evidence only — no model is configured, so nothing here was argued or judged.`,
      llm_role: `No LLM key configured. Deterministic reader resolved ${ticker}. ${gatheredNote} No debate, no judge; the table and the gap are exchange data and arithmetic.`,
    };
  }

  // Abstain before arguing when the computed floor isn't there.
  if (ev.coverage.computed_ok < 3) {
    return {
      ...base(thesis, company, ev),
      replay,
      read: readMeta,
      judge: { call: "insufficient_evidence", p_thesis_holds: 0.5, confidence: 0, what_is_priced_in: "", strongest_attack: "", reasoning: "Fewer than three computed rows came back; the desk will not argue over a table it cannot stand on.", citations: [], struck: [], samples: 0 },
      verdict_line: `${ticker}: only ${ev.coverage.computed_ok} computed rows came back — insufficient evidence to judge the thesis right now.`,
      llm_role: `Read the thesis (1 small call). ${gatheredNote} Abstained before the debate: too few computed rows.`,
    };
  }

  const agree = nothingContested(ev);
  if (agree) {
    return {
      ...base(thesis, company, ev),
      replay,
      read: readMeta,
      judge: { call: "priced_in", p_thesis_holds: 0.5, confidence: Math.min(0.7, ev.coverage.ratio), what_is_priced_in: agree, strongest_attack: "", reasoning: "Every market that prices this company agrees with the cash market; there is no disagreement for a debate to resolve.", citations: ["gap", "perp", "cash", "session"], struck: [], samples: 0 },
      verdict_line: agree,
      llm_role: `Read the thesis (1 small call). ${gatheredNote} Nothing contested — debate skipped by rule, not by a model.`,
    };
  }

  let transcript: Awaited<ReturnType<typeof runDebate>>;
  let judge: Awaited<ReturnType<typeof runJudge>>;
  try {
    transcript = await runDebate(ev, budget);
    judge = await runJudge(ev, transcript, budget);
  } catch (err) {
    // The model didn't answer in time. The computed legs still stand, so hand them
    // over with the archive's base rate rather than failing the whole read.
    console.error(`desk: debate/judge unavailable — ${err instanceof Error ? err.message : err}`);
    return {
      ...base(thesis, company, ev),
      replay,
      read: readMeta,
      verdict_line: ev.analogs?.base_rate_p != null
        ? `${ticker}: base rate from ${ev.analogs.n} comparable ${ev.analogs.kind} windows — P(holds) ${Math.round(ev.analogs.base_rate_p * 100)}%, median move ${ev.analogs.median_move_pct}%, worst against ${ev.analogs.worst_against_pct}%. The debate didn't complete this read, so nothing was argued.`
        : `${ticker}: computed evidence only — the debate didn't complete this read, so nothing was argued or judged.`,
      llm_role: `Read the thesis (1 small call). ${gatheredNote} The debate didn't complete (model timeout or language check); no debate, no judge on this read. The table and the gap are exchange data and arithmetic.`,
    };
  }

  const pct = Math.round(judge.p_thesis_holds * 100);
  let line = `${ticker}: ${callWord[judge.call]} — P(holds) ${pct}%, confidence ${Math.round(judge.confidence * 100)}% on ${ev.coverage.ok}/${ev.coverage.total} rows.`;
  const lint = lintVerdictStrings([line]);
  if (!lint.ok) line = `${ticker}: ${callWord[judge.call]} — ${pct}% / ${Math.round(judge.confidence * 100)}% confidence.`;

  return {
    ...base(thesis, company, ev),
    replay,
    transcript,
    debated: true,
    judge,
    read: readMeta,
    verdict_line: line,
    llm_role: `Read the thesis (1 small call). ${gatheredNote} Bull and Bear argued ${transcript.length} turns citing only the table; ${judge.struck.length} citation(s) struck. Judge sampled ${judge.samples}×, median reported, probability capped to [0.10, 0.90], confidence capped by coverage (${ev.coverage.ratio}). Every number on the card was computed by code; the model interpreted and argued.`,
  };
}

if (isCliEntry(import.meta.url)) {
  const budget = new BudgetGuard();
  runDesk(process.argv.slice(2).join(" ") || "Long NVDA perp into earnings — funding looks cheap", budget).then((v) => {
    console.log(JSON.stringify(v, null, 2));
    console.log(`cost: $${budget.total().toFixed(4)}`);
  });
}
