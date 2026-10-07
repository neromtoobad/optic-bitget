import { randomUUID } from "node:crypto";
import { stockRead } from "../lenses/stocks.js";
import { runDesk } from "../desk/index.js";
import { recordDeskRead } from "../desk/ledger.js";
import type { DeskVerdict } from "../desk/types.js";
import { renderCard } from "../card/render.js";
import { BudgetGuard } from "./budget.js";
import { db, insertRead, completeRead, failRead } from "../db.js";
import type { StockVerdict, TouchGrassVerdict } from "../types.js";

export type ForceMode = "stocks" | "touchgrass" | "desk";

export interface PipelineResult {
  readId: string;
  verdict: StockVerdict | TouchGrassVerdict | DeskVerdict;
  costUsd: number;
}

type AnyVerdict = { resolved: unknown; card_url: string | null; card_pending?: boolean };

/** Render a card with a bounded wait; finishes in the background past the timeout. */
async function renderCardBounded(readId: string, verdict: Parameters<typeof renderCard>[1], budget: BudgetGuard) {
  const cardPromise = renderCard(readId, verdict, budget)
    .then((card) => {
      db.prepare("UPDATE reads SET card_url = ? WHERE id = ?").run(card.card_url, readId);
      return card;
    })
    .catch((err) => {
      console.error(`card render failed for ${readId}: ${err}`);
      return null;
    });
  return Promise.race([cardPromise, new Promise<null>((r) => setTimeout(() => r(null), CARD_TIMEOUT_MS))]);
}

async function applyCard(verdict: AnyVerdict, card: { card_url: string } | null, readId: string) {
  if (card) {
    verdict.card_url = card.card_url;
  } else {
    verdict.card_pending = true;
    verdict.card_url = `${(await import("../config.js")).config.publicBaseUrl}/v1/card/${readId}`;
  }
}

// Max time the response waits on the card; past this the card finishes in the
// background and card_pending:true ships with a URL that will start serving.
const CARD_TIMEOUT_MS = 15_000;

/**
 * One read, ledgered: the desk (a trader's idea about a Bitget rToken perp,
 * stress-tested against its own history and argued over cited evidence), the
 * stocks check, or the TouchGrass wellness read. Budget-capped per read; the
 * card renders in parallel and never blocks the verdict.
 */
export async function runRead(
  query: string,
  opts: {
    paidTx?: string;
    forceMode?: ForceMode;
    extras?: { city?: string; tz?: string; at?: string };
  } = {}
): Promise<PipelineResult> {
  const { paidTx } = opts;
  const forceMode: ForceMode = opts.forceMode ?? "desk";
  const readId = randomUUID();
  insertRead(readId, query);
  const budget = new BudgetGuard();

  try {
    // TouchGrass — onchain wellness read (Lifestyle listing). Self-contained.
    if (forceMode === "touchgrass") {
      const { runTouchGrass } = await import("../touchgrass/index.js");
      const base = await runTouchGrass(query, opts.extras ?? {}, budget);
      const v: TouchGrassVerdict = { ...base, card_url: null };
      if (v.wellness) {
        const card = await renderCardBounded(readId, v, budget);
        await applyCard(v, card, readId);
      }
      completeRead(readId, v.resolved, v, v.card_url, budget.total());
      if (paidTx) db.prepare("UPDATE reads SET paid_tx = ? WHERE id = ?").run(paidTx, readId);
      return { readId, verdict: v, costUsd: budget.total() };
    }
    // The Desk — thesis in, cited verdict out. Written to the hash-chained ledger
    // BEFORE it is returned, so the scoreboard can grade it later. No card yet.
    if (forceMode === "desk") {
      const at = opts.extras?.at ? new Date(opts.extras.at) : undefined;
      const v: DeskVerdict = await runDesk(query, budget, at && !Number.isNaN(at.getTime()) ? { at } : {});
      const card = await renderCardBounded(readId, v, budget);
      await applyCard(v, card, readId);
      // Replays are audits of the desk, not forecasts — they never enter the scoreboard.
      if (!v.replay) recordDeskRead(readId, v);
      completeRead(readId, v.resolved, v, v.card_url, budget.total());
      if (paidTx) db.prepare("UPDATE reads SET paid_tx = ? WHERE id = ?").run(paidTx, readId);
      return { readId, verdict: v, costUsd: budget.total() };
    }
    // Stocks desk — the tokenized equity on-chain + equity research + prediction
    // markets on the company → cross-venue read. Self-contained (no crypto resolve).
    if (forceMode === "stocks") {
      const v = await stockRead(query, budget);
      const card = await renderCardBounded(readId, v, budget);
      await applyCard(v, card, readId);
      completeRead(readId, v.resolved, v, v.card_url, budget.total());
      if (paidTx) db.prepare("UPDATE reads SET paid_tx = ? WHERE id = ?").run(paidTx, readId);
      return { readId, verdict: v, costUsd: budget.total() };
    }
    throw new Error(`unknown mode: ${forceMode}`);
  } catch (err) {
    failRead(readId, budget.total());
    throw err;
  }
}
