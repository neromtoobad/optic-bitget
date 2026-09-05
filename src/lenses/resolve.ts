import type { Resolved } from "../types.js";
import { structuredCall } from "../lib/anthropic.js";
import { BudgetGuard } from "../pipeline/budget.js";
import { isCliEntry } from "../fixtures.js";
import { config } from "../config.js";
import { resolveTokenCEX } from "./cex/resolve.js";

// Token search spans the majors — an ERC-20 address or an ethereum-native ticker
// must resolve, not fall through to "narrative" (a real buyer hit this with PEPE:
// 0x6982…1933 read as not-a-token because search was solana-only).

const CLASSIFY_SCHEMA = {
  type: "object",
  properties: {
    kind: {
      type: "string",
      enum: ["token_address", "ticker", "narrative", "scan", "daily", "edge", "smartmoney"],
      description:
        "token_address: a blockchain contract address (base58 or 0x...). ticker: a token symbol or memecoin name (e.g. PEPE, doge, $WIF). narrative: a story, event or theme in plain words (e.g. 'fed rate cut', 'world cup', 'AI agents'). scan: a discovery request over the whole market (e.g. 'scan', 'what's heating up'). daily: today's picks/tips/alpha (e.g. \"today's prediction tip\", \"picks of the day\", \"daily alpha\"). edge: where is the market MISPRICED / where's the value/edge (e.g. \"where's the edge\", \"any mispriced markets\", \"find value\", \"edge radar\"). smartmoney: what smart money / whales are buying (e.g. \"what's smart money buying\", \"whale accumulation\", \"smart money\").",
    },
    cleaned: {
      type: "string",
      description: "The canonical form: address as-is; ticker uppercased without $; narrative lowercased and trimmed.",
    },
  },
  required: ["kind", "cleaned"],
  additionalProperties: false,
} as const;

export type ResolvedOrScan =
  | Resolved
  | { type: "scan"; name: string }
  | { type: "daily"; name: string }
  | { type: "edge"; name: string }
  | { type: "smartmoney"; name: string };

type Classified = { kind: "token_address" | "ticker" | "narrative" | "scan" | "daily" | "edge" | "smartmoney"; cleaned: string };

/**
 * Deterministic fallback classifier. A transient LLM failure must degrade a read,
 * never 500 it — a buyer paid three times into "read failed" when the classify
 * call was down; shape-based rules keep address/ticker reads alive without it.
 */
function heuristicClassify(query: string): Classified {
  const q = query.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(q) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(q))
    return { kind: "token_address", cleaned: q };
  if (/^\$?[A-Za-z0-9_.-]{2,12}$/.test(q)) return { kind: "ticker", cleaned: q.replace(/^\$/, "").toUpperCase() };
  return { kind: "narrative", cleaned: q.toLowerCase() };
}

export async function resolve(query: string, budget: BudgetGuard): Promise<ResolvedOrScan> {
  let cls: Classified;
  try {
    cls = await structuredCall<Classified>({
      label: "resolve_classify",
      system:
        "You classify a crypto market query. Classify precisely; do not guess a ticker out of a phrase that reads as a story or event.",
      user: query,
      schema: CLASSIFY_SCHEMA as unknown as Record<string, unknown>,
      budget,
      maxTokens: 200,
      effort: "low",
    });
  } catch (err) {
    console.error(`resolve classify failed, using heuristic: ${(err as Error).message}`);
    cls = heuristicClassify(query);
  }

  if (cls.kind === "scan") {
    return { type: "scan", name: "market scan" };
  }
  if (cls.kind === "daily") {
    return { type: "daily", name: "daily alpha" };
  }
  if (cls.kind === "edge") {
    return { type: "edge", name: "edge radar" };
  }
  if (cls.kind === "smartmoney") {
    return { type: "smartmoney", name: "smart money" };
  }
  if (cls.kind === "narrative") {
    return { type: "narrative", name: cls.cleaned };
  }

  // Canonicalise via CEX Web3 token search + the exchange's own listings.
  // Unresolvable → narrative, never invented token data.
  const r = await resolveTokenCEX(cls.cleaned, budget);
  return r ?? { type: "narrative", name: cls.cleaned.toLowerCase() };
}

if (isCliEntry(import.meta.url)) {
  const budget = new BudgetGuard();
  resolve(process.argv[2] ?? "pepe", budget).then((r) => {
    console.log(JSON.stringify(r, null, 2));
    console.log(`cost: $${budget.total().toFixed(5)}`);
  });
}
