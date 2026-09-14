import { structuredCall } from "../lib/anthropic.js";
import type { BudgetGuard } from "../pipeline/budget.js";
import type { DebateRole, DebateTurn, EvidenceTable } from "./types.js";

// DEBATE — two analysts argue the trader's thesis against the evidence table.
// Lifted from delphi-duel's Bull/Bear protocol with one inversion: those agents
// had no live data and were told to reason from priors. These have the table
// and may cite NOTHING else. Every turn lists the row ids it leans on; a
// citation to a row that doesn't exist, or that came back empty/error, is
// struck before the judge reads it. The trader sees `reasoning`; the peer
// sees only `message_to_peer`.

const ROUNDS = 2; // bull0 bear0 bull1 bear1 — four turns, bounded cost
const MAX_TOKENS = 700;

const TURN_SCHEMA = {
  type: "object",
  properties: {
    probability: { type: "number", description: "P(the thesis holds — the trader's read is right AND not already reflected in the markets), 0-1. Both sides report in this same space." },
    confidence: { type: "number", description: "0-1: how sure you are of your probability. Orthogonal to the probability itself." },
    reasoning: { type: "string", description: "3-5 dense sentences of analysis the TRADER reads. Cite evidence by [id] inline, e.g. [gap], [funding]. Name the mechanism and what would change your mind." },
    message_to_peer: { type: "string", description: "2-3 sentences to the other analyst. Land one specific point: advance or rebut. Cite [id]s." },
    citations: { type: "array", items: { type: "string" }, description: "Every evidence row id your turn relies on. Only ids from the table." },
  },
  required: ["probability", "confidence", "reasoning", "message_to_peer", "citations"],
  additionalProperties: false,
} as const;

function systemFor(role: DebateRole): string {
  const side = role === "bull" ? "FOR" : "AGAINST";
  const stance =
    role === "bull"
      ? "Make the strongest honest case that the thesis holds — that the trader's read is right and the markets have not already priced it. You will usually start above 0.5 and move down only when the Bear lands a real blow."
      : "Make the strongest honest case that the thesis does NOT hold — that the read is wrong, or already in the price. You will usually start below 0.5 and move up only when the Bull lands a real blow.";
  return (
    `You are the ${role === "bull" ? "Bull" : "Bear"} on OPTIC's research desk for Bitget's tokenized US-stock perpetuals (rTokens), arguing ${side} a trader's thesis. A second analyst argues the other side; a judge reads both and the trader decides. ${stance}\n\n` +
    "EVIDENCE RULE — the only rule that matters: you may cite ONLY the rows in the EVIDENCE TABLE you are given, by their [id]. No outside facts, no recalled prices, no invented statistics. If the table lacks what you need, say the evidence is missing — that is a legitimate and respected move. A claim with no citation, or citing a row whose status is not ok, will be STRUCK by the judge. Rows marked computed=true are exchange data and arithmetic; computed=false rows are a model's web brief — cite them, but weigh them as argued, not measured.\n\n" +
    "Voice: a senior analyst briefing a client at 8am. Dense, specific, calm. Engage the peer's last specific point; don't pivot. Update honestly when they are right — a small move (0.03–0.08) acknowledges, a large move (>0.15) concedes the point was decisive. Never capitulate fully. Refer to the trader's idea as 'the thesis'. This is a DATA product: never tell anyone to buy, sell, hold, go long or short, and never state a price target as advice — describe what the evidence shows.\n\n" +
    "Know the instrument: an rToken perpetual trades 24/7 while the underlying trades 6.5h a day. When [session] says the cash market is closed, the perp is the only live price on the company; [gap] measures how far it has drifted from the last cash print; basis is the exchange's own perp-vs-index gap; funding is what the crowd pays to hold the disagreement."
  );
}

function tableText(ev: EvidenceTable): string {
  const lines = ev.rows.map((r) => {
    const head = `[${r.id}] ${r.label} — source=${r.source} computed=${r.computed} status=${r.status}${r.note ? ` note="${r.note}"` : ""}`;
    if (r.status !== "ok") return head;
    const v = typeof r.value === "string" ? r.value : JSON.stringify(r.value);
    return `${head}\n${v}`;
  });
  return lines.join("\n\n");
}

function userFor(role: DebateRole, ev: EvidenceTable, round: number, peerLast: string | null, selfLast: string | null): string {
  const peer = role === "bull" ? "Bear" : "Bull";
  const parts = [
    `THESIS (the trader's, verbatim): ${ev.thesis}`,
    `Company: ${ev.company} (${ev.ticker}) · Bitget perpetual: ${ev.symbol ?? "none listed"} · Today: ${ev.gathered_at.slice(0, 10)}`,
    `Coverage: ${ev.coverage.ok}/${ev.coverage.total} rows ok (${ev.coverage.computed_ok} computed).`,
    "",
    "EVIDENCE TABLE",
    tableText(ev),
    "",
    `ROUND ${round}`,
    round === 0 || peerLast === null ? `PEER'S LAST TURN (from ${peer}): (opening round — no peer message yet; open with your reading)` : `PEER'S LAST TURN (from ${peer}):\n${peerLast}`,
  ];
  if (selfLast) parts.push("", "YOUR LAST MESSAGE TO PEER (for continuity; do not repeat):", selfLast);
  return parts.join("\n");
}

/** Validate citations against the table: unknown ids and non-ok rows are struck. */
export function strikeCitations(citations: string[], ev: EvidenceTable): { kept: string[]; struck: string[] } {
  const ok = new Set(ev.rows.filter((r) => r.status === "ok").map((r) => r.id));
  const kept: string[] = [];
  const struck: string[] = [];
  for (const c of new Set(citations.map((s) => String(s).replace(/[\[\]]/g, "").trim()).filter(Boolean))) {
    (ok.has(c) ? kept : struck).push(c);
  }
  return { kept, struck };
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, Number.isFinite(x) ? x : 0.5));

async function turn(role: DebateRole, ev: EvidenceTable, round: number, peerLast: string | null, selfLast: string | null, budget: BudgetGuard): Promise<DebateTurn> {
  const out = await structuredCall<{ probability: number; confidence: number; reasoning: string; message_to_peer: string; citations: string[] }>({
    label: `desk_${role}_${round}`,
    system: systemFor(role),
    user: userFor(role, ev, round, peerLast, selfLast),
    schema: TURN_SCHEMA as unknown as Record<string, unknown>,
    budget,
    maxTokens: MAX_TOKENS,
    effort: "medium",
  });
  const { kept, struck } = strikeCitations(out.citations ?? [], ev);
  return {
    role,
    round,
    probability: clamp01(out.probability),
    confidence: clamp01(out.confidence),
    reasoning: String(out.reasoning ?? "").trim(),
    message_to_peer: String(out.message_to_peer ?? "").trim(),
    citations: kept,
    struck,
  };
}

/** Run the bounded debate. Bull opens each round; Bear answers. */
export async function runDebate(ev: EvidenceTable, budget: BudgetGuard, rounds = ROUNDS): Promise<DebateTurn[]> {
  const transcript: DebateTurn[] = [];
  let bullLast: string | null = null;
  let bearLast: string | null = null;
  for (let r = 0; r < rounds; r++) {
    const bull = await turn("bull", ev, r, bearLast, bullLast, budget);
    transcript.push(bull);
    bullLast = bull.message_to_peer;
    const bear = await turn("bear", ev, r, bullLast, bearLast, budget);
    transcript.push(bear);
    bearLast = bear.message_to_peer;
  }
  return transcript;
}
