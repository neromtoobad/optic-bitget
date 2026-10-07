import { structuredCall } from "../lib/anthropic.js";
import { lintVerdictStrings } from "../lint.js";
import type { BudgetGuard } from "../pipeline/budget.js";
import type { DebateTurn, EvidenceTable, JudgeCall, JudgeVerdict } from "./types.js";
import { strikeCitations } from "./debate.js";

// JUDGE — reads the whole transcript plus the evidence table and scores what
// survived. Three things the forecasting literature says separate calibrated
// forecasters from fluent ones, all enforced here rather than requested:
//   • a structured probability, not a narrative one (narrative prompts wreck
//     calibration), CAPPED to [0.10, 0.90] — the strongest single practice
//     among winning forecasting bots;
//   • an ENSEMBLE: the judge is sampled N times and the median is reported;
//   • confidence is capped by evidence coverage — missing rows lower how sure
//     the desk is, never what it concluded.
// The judge may return INSUFFICIENT_EVIDENCE. That is a verdict, and it is
// graded like any other on the scoreboard.

const SAMPLES = 3;
const P_MIN = 0.1;
const P_MAX = 0.9;

const JUDGE_SCHEMA = {
  type: "object",
  properties: {
    call: { type: "string", enum: ["holds", "priced_in", "contested", "insufficient_evidence"], description: "holds: the thesis survived and the markets have not priced it. priced_in: the evidence shows it is already in the price or the read is wrong. contested: both sides landed and the table can't settle it. insufficient_evidence: the rows needed to judge are missing or not ok — say so rather than guess." },
    p_thesis_holds: { type: "number", description: "Your own probability, 0-1, that the thesis holds. Use the transcript AND the table; do not average the analysts' numbers." },
    confidence: { type: "number", description: "0-1: how sure you are of `call`. Weigh evidence QUALITY over the analysts' stated confidence — a confident turn with weak citations has not earned its number." },
    what_is_priced_in: { type: "string", description: "One or two observational sentences: what the markets already reflect about this company, citing [id]s." },
    strongest_attack: { type: "string", description: "One sentence: the single surviving argument that would make the trader wrong, citing [id]s. If the thesis held cleanly, the strongest remaining risk." },
    reasoning: { type: "string", description: "2-3 sentences on which specific arguments tipped the verdict and which were discounted." },
    citations: { type: "array", items: { type: "string" }, description: "The evidence row ids your verdict rests on." },
  },
  required: ["call", "p_thesis_holds", "confidence", "what_is_priced_in", "strongest_attack", "reasoning", "citations"],
  additionalProperties: false,
} as const;

const SYSTEM =
  "You are the Judge on OPTIC's research desk for Bitget's tokenized US-stock perpetuals. Two analysts argued a trader's thesis against an evidence table; you read the complete transcript — including each side's private reasoning — and the table itself, and you tell the trader what the debate actually established. You are an arbiter, not an advocate.\n\n" +
  "EVIDENCE RULE: a claim is only as good as its citation. Citations marked STRUCK were to rows that don't exist or weren't ok — treat those claims as unsupported. Numbers that do not appear in a cited row were invented — discount them. Rows with computed=false are a model's web brief: admissible, but measured rows outrank them.\n\n" +
  "CALIBRATION: give a structured probability, not a feeling. Weigh evidence quality over stated confidence. If the rows needed to decide are missing, return insufficient_evidence — an honest abstention beats a fluent guess, and abstentions are scored on this desk.\n\n" +
  "This is a DATA product. Never tell the trader to buy, sell, hold, go long or short; never give a price target as advice. Refer to the trader's idea as 'the thesis'. Language is observational: priced-in, lagging, crowded, catalyst-ahead, contested.";

function transcriptText(t: DebateTurn[]): string {
  return t
    .map((x) => {
      const struck = x.struck.length ? ` STRUCK=[${x.struck.join(", ")}]` : "";
      return `── round ${x.round} — ${x.role.toUpperCase()} — P(holds)=${x.probability.toFixed(2)} confidence=${x.confidence.toFixed(2)} cites=[${x.citations.join(", ")}]${struck} ──\nReasoning (private): ${x.reasoning}\nMessage to peer: ${x.message_to_peer}`;
    })
    .join("\n\n");
}

function tableSummary(ev: EvidenceTable): string {
  return ev.rows
    .map((r) => {
      const head = `[${r.id}] ${r.label} — computed=${r.computed} status=${r.status}${r.note ? ` (${r.note})` : ""}`;
      if (r.status !== "ok") return head;
      const v = typeof r.value === "string" ? r.value : JSON.stringify(r.value);
      return `${head}\n${v}`;
    })
    .join("\n\n");
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(x) ? x : (lo + hi) / 2));
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

type Sample = { call: JudgeCall; p_thesis_holds: number; confidence: number; what_is_priced_in: string; strongest_attack: string; reasoning: string; citations: string[] };

async function sample(ev: EvidenceTable, transcript: DebateTurn[], i: number, budget: BudgetGuard, feedback = ""): Promise<Sample> {
  const out = await structuredCall<Sample>({
    label: `desk_judge_${i}`,
    system: SYSTEM,
    user:
      [
        `THESIS (the trader's, verbatim): ${ev.thesis}`,
        `Company: ${ev.company} (${ev.ticker}) · Bitget perpetual: ${ev.symbol ?? "none listed"} · Coverage: ${ev.coverage.ok}/${ev.coverage.total} rows ok (${ev.coverage.computed_ok} computed)`,
        "",
        "EVIDENCE TABLE",
        tableSummary(ev),
        "",
        "TRANSCRIPT",
        transcriptText(transcript),
      ].join("\n") + feedback,
    schema: JUDGE_SCHEMA as unknown as Record<string, unknown>,
    budget,
    maxTokens: 700,
    effort: "high",
  });
  return out;
}

/**
 * Sample the judge N times and aggregate: median probability and confidence,
 * majority call, and the prose from the sample nearest the median. Then apply
 * the two caps — probability to [0.10, 0.90], confidence to the coverage ratio.
 */
export async function runJudge(ev: EvidenceTable, transcript: DebateTurn[], budget: BudgetGuard, samples = SAMPLES): Promise<JudgeVerdict> {
  // The samples are independent draws, so they run side by side; each keeps its
  // own lint retry. Order is kept so the prose still comes from the sample
  // nearest the median.
  const one = async (i: number): Promise<Sample> => {
    let feedback = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const s = await sample(ev, transcript, i, budget, feedback);
      const lint = lintVerdictStrings([s.what_is_priced_in, s.strongest_attack, s.reasoning]);
      if (lint.ok) return s;
      feedback = `\n\nPrevious output failed the language lint on: ${JSON.stringify(lint.violations.map((v) => v.word))}. Rewrite without those words.`;
    }
    throw new Error("judge output failed banned-word lint after retry");
  };
  const outs: Sample[] = await Promise.all(Array.from({ length: samples }, (_, i) => one(i)));

  const pMed = median(outs.map((o) => clamp(o.p_thesis_holds, 0, 1)));
  const cMed = median(outs.map((o) => clamp(o.confidence, 0, 1)));
  const counts = new Map<JudgeCall, number>();
  for (const o of outs) counts.set(o.call, (counts.get(o.call) ?? 0) + 1);
  const call = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  // Prose from the sample closest to the median probability — the one the numbers describe.
  const rep = outs.reduce((best, o) => (Math.abs(o.p_thesis_holds - pMed) < Math.abs(best.p_thesis_holds - pMed) ? o : best), outs[0]);

  const { kept } = strikeCitations(rep.citations ?? [], ev);
  const struck = transcript.flatMap((t) => t.struck.map((id) => ({ role: t.role, round: t.round, id, reason: ev.rows.find((r) => r.id === id) ? `row "${id}" was ${ev.rows.find((r) => r.id === id)!.status}` : `no such row "${id}"` })));

  return {
    call,
    p_thesis_holds: Math.round(clamp(pMed, P_MIN, P_MAX) * 100) / 100,
    // Coverage caps confidence: a verdict on 6 of 10 rows cannot be more than 0.6 sure.
    confidence: Math.round(Math.min(cMed, ev.coverage.ratio) * 100) / 100,
    what_is_priced_in: rep.what_is_priced_in.trim(),
    strongest_attack: rep.strongest_attack.trim(),
    reasoning: rep.reasoning.trim(),
    citations: kept,
    struck,
    samples: outs.length,
  };
}
