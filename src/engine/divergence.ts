import type { Attention, BinanceVenue, Divergence, MemeVenue, PredictionVenue, Research, Resolved, UnlockNews } from "../types.js";
import { structuredCall } from "../lib/anthropic.js";
import { lintVerdictStrings } from "../lint.js";
import type { BudgetGuard } from "../pipeline/budget.js";

export interface DivergenceResult {
  divergence: Divergence;
  verdict_line: string;
}

const DIVERGENCE_SCHEMA = {
  type: "object",
  properties: {
    score: {
      type: "integer",
      description:
        "Gap 0-100. Rubric: 0-20 markets aligned; 21-50 mild lag between markets; 51-80 clear disagreement; 81-100 extreme disconnect. Judge how differently the markets price the SAME story.",
    },
    direction: {
      type: "string",
      enum: [
        "aligned",
        "attention_ahead_of_markets",
        "markets_ahead_of_attention",
        "meme_ahead_of_prediction",
        "prediction_ahead_of_meme",
        "exchange_ahead_of_onchain",
        "onchain_ahead_of_exchange",
        "perps_crowded",
        "perps_ahead_of_spot",
      ],
    },
    one_liner: {
      type: "string",
      description: "One sentence citing the single strongest concrete fact behind the score.",
    },
    reasoning: {
      type: "array",
      items: { type: "string" },
      description: "2-4 short observations comparing the market reads. Each cites data present in the input.",
    },
    verdict_line: {
      type: "string",
      description: "The shareable headline read, <= 140 chars, observational.",
    },
  },
  required: ["score", "direction", "one_liner", "reasoning", "verdict_line"],
  additionalProperties: false,
} as const;

const SYSTEM = `You are OPTIC's gap engine. You compare how three markets price the same story:
- ATTENTION (social): hotness score 0-100, trend, mentions, sentiment, KOLs
- MEME market (onchain): price, 24h change, liquidity, holders, dev/holder-concentration flags
- PREDICTION market (outcome markets): related markets with yes-prices, 24h odds movement (yes_chg_24h), and volume
- UNLOCK NEWS (supply events): news items about scheduled unlocks/vesting for this token — report dates and sizes as facts; scheduled supply expansion is context the other markets may or may not be pricing
- NEWS (research headlines for narratives): the reported facts behind the story — compare what the news says against what the odds price; a market whose odds moved against fresh news IS a divergence
- RESEARCH (web-sourced context — the value-add): recent form, injuries, roster/lineup news, weather, catalysts for the subject. This is the WHY behind the market read. When research is present, your job is to EXPLAIN the odds with it and flag where the research adds nuance the raw number misses (e.g. "favourite is missing two starters — the underdog price may be softer than it looks"). Cite specific researched facts. This is what makes the read worth paying for — do not ignore it when present.
- TOKEN_RISK (Rug Radar, tokens only): a 0-100 safety score + red flags (dev rug history, holder concentration, LP status). When present and elevated, surface the top flags — a trader must see these. Factual risk disclosure, never advice.
- NARRATIVE_TIMING (tokens only): lifecycle stage — igniting/building/peaking/cooling. Say whether the attention is early or late.
- SMART_MONEY (tokens only): sharp-wallet accumulation (wallet count + buy volume). When present, note that smart money is active on this token — factual flow, never a trade instruction.
- BINANCE market (the exchange, when present): spot price + 24h change + volume, and the perps positioning around the same story — funding rate (positive = accounts positioned for a rise are paying to hold; strongly positive or negative = a crowded side), open interest and its 24h change (rising OI with a flat price = leverage building; falling OI = positions closing), the share of accounts positioned for a rise, taker flow ratio (>1 = aggressive bids dominate), and perp basis. Compare the EXCHANGE against the other markets: leverage crowding one way while attention or the onchain market says the opposite IS a divergence; the exchange moving first while onchain/social lag (or the reverse) is a direction. Cite the funding/OI/skew numbers when they carry the read. Use the words "positioned for a rise/fall", "up-skewed/down-skewed", "leverage", "crowded" — never the banned words below.

Rules — non-negotiable:
- Disagreement between markets IS the signal. Score it with the rubric in the schema.
- When research is present, the verdict_line and reasoning should lead with the substantive read (favourite + the key research factor), not just the gap score.
- A null market is itself signal: no prediction market pricing a hot story means attention is unhedged; say so.
- NEVER invent data. Every claim cites a number present in the input.
- Report the map, never a trade instruction. Observational language only: priced-in, lagging, crowded, asleep, unhedged.
- Plain words: say "market(s)", never "venue(s)"; say the markets "agree", "disagree" or one "lags", never "diverge/divergence" in user-facing text.
- BANNED words (will fail lint): buy, sell, long, short, ape, moon. Also no action/advice verbs of any kind: accumulate, exit, exploit, fade, play, enter, bet.
- Numbers: round sensibly; percentages with one decimal at most.`;

// DIVERGENCE engine — the one comparison at the heart of OPTIC.
export async function computeDivergence(
  resolved: Resolved,
  attention: Attention | null,
  meme: MemeVenue | null,
  prediction: PredictionVenue | null,
  unlockNews: UnlockNews[] | null,
  news: UnlockNews[] | null,
  research: Research | null,
  tokenAlpha: {
    risk: import("../lenses/risk.js").RiskRadar | null;
    timing: import("../lenses/timing.js").Timing | null;
    smartMoney: import("../lenses/smartmoney.js").SmartMoneyToken | null;
    binance?: BinanceVenue | null; // Binance edition: the exchange read (spot + perps)
  },
  budget: BudgetGuard
): Promise<DivergenceResult> {
  const binance = tokenAlpha.binance ?? null;
  const input = JSON.stringify({
    subject: resolved,
    attention,
    venues: {
      meme,
      prediction,
      unlock_news: unlockNews,
      news,
      ...(binance !== undefined && binance !== null
        ? {
            binance: {
              symbol: binance.symbol,
              source: binance.source,
              spot: binance.spot,
              perps: binance.perps,
              basis_pct: binance.basis_pct,
              read: binance.read,
            },
          }
        : {}),
    },
    research: research?.brief ?? null,
    token_risk: tokenAlpha.risk ? { score: tokenAlpha.risk.score, level: tokenAlpha.risk.level, flags: tokenAlpha.risk.flags } : null,
    narrative_timing: tokenAlpha.timing ? { stage: tokenAlpha.timing.stage, read: tokenAlpha.timing.read } : null,
    smart_money: tokenAlpha.smartMoney ? { wallets: tokenAlpha.smartMoney.wallets, buy_usd: Math.round(tokenAlpha.smartMoney.buy_usd) } : null,
  });

  let feedback = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = await structuredCall<Divergence & { verdict_line: string }>({
      label: attempt === 0 ? "divergence" : "divergence_retry",
      system: SYSTEM,
      user: input + feedback,
      schema: DIVERGENCE_SCHEMA as unknown as Record<string, unknown>,
      budget,
      maxTokens: 700,
    });

    // Coerce a safe shape — smaller models occasionally omit a field or return the
    // wrong type; never crash on that, and never ship undefined into the card/db.
    const raw = out as unknown as Record<string, unknown>;
    const divergence: Divergence = {
      score: typeof raw.score === "number" ? Math.max(0, Math.min(100, Math.round(raw.score))) : 50,
      direction: (typeof raw.direction === "string" ? raw.direction : "aligned") as Divergence["direction"],
      one_liner: typeof raw.one_liner === "string" ? raw.one_liner : "",
      reasoning: Array.isArray(raw.reasoning) ? raw.reasoning.filter((r): r is string => typeof r === "string") : [],
    };
    const verdict_line =
      typeof raw.verdict_line === "string" && raw.verdict_line.trim()
        ? raw.verdict_line
        : `${resolved.name}: ${divergence.one_liner || "markets read together across venues."}`;

    const lint = lintVerdictStrings([verdict_line, divergence.one_liner, ...divergence.reasoning]);
    if (lint.ok) {
      return { divergence, verdict_line };
    }
    feedback = `\n\nYour previous output failed the language lint on: ${JSON.stringify(lint.violations.map((v) => v.word))}. Rewrite without those words.`;
  }
  throw new Error("divergence output failed banned-word lint after retry");
}
