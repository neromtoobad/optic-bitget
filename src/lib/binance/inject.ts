import type { BinanceVenue } from "../../types.js";
import { composeRead } from "../../lenses/binance/cex.js";

// INJECTED EXCHANGE READ — the caller's own Binance MCP session, borrowed.
//
// Binance's MCP Server only accepts connections from its allowlist of approved
// agent clients (Claude Code, ChatGPT, Codex, Cursor, VS Code, Grok). A
// third-party service cannot hold that session, and should not pretend to be a
// client that can. So the connection lives where Binance intends it to live —
// in the user's own agent — and that agent hands Optic what the MCP tools
// returned. Optic parses it into the exchange venue and marks the source
// honestly as `binance-mcp`, because that is where the numbers came from.
//
// Shapes vary by tool and by client, so nothing here is positional: every field
// is found by name, one level of nesting deep, from an object or an array of
// objects. A payload that yields no price is rejected rather than half-read.

type Json = unknown;

const asNumber = (v: unknown): number | null => {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Every object in the payload, flattened one level through arrays and common wrappers. */
function objects(payload: Json, depth = 0): Array<Record<string, unknown>> {
  if (payload == null || depth > 4) return [];
  if (typeof payload === "string") {
    // An agent often pastes the tool's text block verbatim.
    try {
      return objects(JSON.parse(payload), depth + 1);
    } catch {
      return [];
    }
  }
  if (Array.isArray(payload)) return payload.flatMap((p) => objects(p, depth + 1));
  if (typeof payload !== "object") return [];
  const rec = payload as Record<string, unknown>;
  const nested = ["data", "result", "content", "structuredContent", "ticker", "payload", "items", "text"].flatMap((k) =>
    rec[k] !== undefined ? objects(rec[k], depth + 1) : []
  );
  return [rec, ...nested];
}

/** First numeric value across the payload whose key matches, optionally scoped to a symbol. */
function pick(objs: Array<Record<string, unknown>>, names: RegExp, symbol?: string): number | null {
  const scoped = symbol
    ? objs.filter((o) => o.symbol === undefined || String(o.symbol).toUpperCase() === symbol.toUpperCase())
    : objs;
  for (const o of scoped) {
    for (const [k, v] of Object.entries(o)) {
      if (names.test(k)) {
        const n = asNumber(v);
        if (n !== null) return n;
      }
    }
  }
  return null;
}

function pickString(objs: Array<Record<string, unknown>>, names: RegExp): string | null {
  for (const o of objs) {
    for (const [k, v] of Object.entries(o)) {
      if (names.test(k) && typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return null;
}

const round = (n: number | null, d = 2): number | null => (n === null ? null : Math.round(n * 10 ** d) / 10 ** d);

/**
 * Build the exchange venue from whatever the caller's Binance MCP tools returned.
 * Returns null when no price is present — an unreadable payload is not a read.
 */
export function exchangeFromMcpPayload(payload: Json, fallbackSymbol?: string): BinanceVenue | null {
  const objs = objects(payload);
  if (objs.length === 0) return null;

  const symbol = (pickString(objs, /^(symbol|pair|instrument)$/i) ?? fallbackSymbol ?? "").toUpperCase();
  if (!symbol) return null;

  const price = pick(objs, /^(lastPrice|price|last|close|currentPrice|weightedAvgPrice)$/i, symbol);
  const markPrice = pick(objs, /^(markPrice|mark)$/i, symbol);
  if (price === null && markPrice === null) return null;

  const spot =
    price === null
      ? null
      : {
          price,
          chg_24h: round(pick(objs, /^(priceChangePercent|percentChange24h|change24h|changePercent|priceChangePct)$/i, symbol)),
          volume_24h_usd: pick(objs, /^(quoteVolume|quoteVolume24h|volumeUsd|turnover|quoteAssetVolume)$/i, symbol),
          high_24h: pick(objs, /^(highPrice|high24h|high)$/i, symbol),
          low_24h: pick(objs, /^(lowPrice|low24h|low)$/i, symbol),
        };

  const funding = pick(objs, /^(lastFundingRate|fundingRate|funding)$/i, symbol);
  const openInterest = pick(objs, /^(openInterest|sumOpenInterest|oi)$/i, symbol);
  const openInterestUsd = pick(objs, /^(openInterestValue|sumOpenInterestValue|openInterestUsd)$/i, symbol);
  const nextFunding = pick(objs, /^(nextFundingTime|nextFundingAt)$/i, symbol);
  const longAccount = pick(objs, /^(longAccount|longAccountRatio|longRatio)$/i, symbol);
  const longShort = pick(objs, /^(longShortRatio|longShortAccountRatio)$/i, symbol);
  const takerRatio = pick(objs, /^(buySellRatio|takerBuySellRatio)$/i, symbol);

  const hasPerps = [funding, openInterest, openInterestUsd, markPrice, longAccount, longShort, takerRatio].some((v) => v !== null);
  const perps = hasPerps
    ? {
        mark_price: markPrice,
        funding_rate: funding,
        funding_annualized_pct: funding === null ? null : round(funding * 3 * 365 * 100, 1),
        next_funding_at: nextFunding ? new Date(nextFunding).toISOString() : null,
        open_interest: openInterest,
        open_interest_usd: openInterestUsd ?? (openInterest !== null && (markPrice ?? price) !== null ? openInterest * (markPrice ?? price)! : null),
        open_interest_chg_24h: null, // a single snapshot carries no history
        accounts_up_pct: longAccount === null ? null : round(longAccount <= 1 ? longAccount * 100 : longAccount, 1),
        accounts_up_down_ratio: round(longShort, 2),
        taker_flow_ratio: round(takerRatio, 2),
      }
    : null;

  const basis = spot?.price && perps?.mark_price ? round(((perps.mark_price - spot.price) / spot.price) * 100, 3) : null;
  return { symbol, source: "binance-mcp", spot, perps, basis_pct: basis, read: composeRead(symbol, spot, perps, basis) };
}
