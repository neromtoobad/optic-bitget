// TICKET DESK · plugin rail — Polymarket 5-minute Up/Down markets.
//
// Verified live Jul 19: every OKX.AI buyer agent can execute these through OKX's own
// polymarket-plugin (plugin-store), driven by the agentic wallet it already has —
// `polymarket-plugin buy --market-id <conditionId> --outcome up --amount <usdc>`.
// The plugin carries its own safety protocol (paper-mode default, typed live-mode
// confirmation, preview before writes), so the execution stays on the BUYER's rails
// with the buyer's own gates. Optic only constructs the instruction.
//
// Market discovery is pure public data: slugs follow `<coin>-updown-5m-<ts>` where
// ts is the 300s-aligned window START (verified against Gamma). Resolution source is
// a Chainlink price stream.
const GAMMA = "https://gamma-api.polymarket.com";
const TIMEOUT_MS = 10_000;

export const UPDOWN_COINS = ["BTC", "ETH", "SOL", "XRP", "BNB", "DOGE", "HYPE"] as const;

export interface UpdownMarket {
  coin: string;
  condition_id: string;
  slug: string;
  question: string;
  window_start_utc: string;
  window_end_utc: string;
  up_price: number | null;
  down_price: number | null;
  liquidity: number;
  accepting_orders: boolean;
}

interface GammaMarket {
  question?: string;
  conditionId?: string;
  slug?: string;
  endDate?: string;
  liquidity?: string;
  acceptingOrders?: boolean;
  outcomes?: string;
  outcomePrices?: string;
}

/** True when the query is asking about a short-horizon up/down window. */
export function isUpdownQuery(q: string): boolean {
  return /\b(updown|up.?or.?down|up.?down|5 ?-?min|15 ?-?min|next (5|15))\b/i.test(q);
}

/** Detect which updown coin the query names, if any. */
export function updownCoin(q: string): string | null {
  const lower = q.toLowerCase();
  const aliases: Record<string, string> = {
    btc: "BTC", bitcoin: "BTC", eth: "ETH", ether: "ETH", ethereum: "ETH",
    sol: "SOL", solana: "SOL", xrp: "XRP", bnb: "BNB", doge: "DOGE", dogecoin: "DOGE", hype: "HYPE",
  };
  for (const [alias, coin] of Object.entries(aliases)) {
    if (new RegExp(`\\b${alias}\\b`).test(lower)) return coin;
  }
  return null;
}

/**
 * Resolve the next open 5-minute Up/Down window for a coin. Walks the 300s slug
 * grid from the current window forward until one is accepting orders.
 */
export async function resolveUpdown(coin: string): Promise<UpdownMarket | null> {
  const nowSec = Math.floor(Date.now() / 1000);
  const currentWindow = Math.floor(nowSec / 300) * 300;
  for (let k = 0; k < 4; k++) {
    const ts = currentWindow + k * 300;
    const slug = `${coin.toLowerCase()}-updown-5m-${ts}`;
    try {
      const res = await fetch(`${GAMMA}/markets?slug=${slug}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) continue;
      const arr = (await res.json()) as GammaMarket[];
      const m = arr?.[0];
      if (!m?.conditionId || m.acceptingOrders === false) continue;
      let up: number | null = null;
      let down: number | null = null;
      try {
        const outcomes = JSON.parse(m.outcomes ?? "[]") as string[];
        const prices = JSON.parse(m.outcomePrices ?? "[]") as string[];
        const upIdx = outcomes.findIndex((o) => o.toLowerCase() === "up");
        const downIdx = outcomes.findIndex((o) => o.toLowerCase() === "down");
        if (upIdx >= 0) up = Number(prices[upIdx]);
        if (downIdx >= 0) down = Number(prices[downIdx]);
      } catch {
        /* prices stay null — the command is still constructible */
      }
      return {
        coin,
        condition_id: m.conditionId,
        slug,
        question: m.question ?? `${coin} Up or Down`,
        window_start_utc: new Date(ts * 1000).toISOString(),
        window_end_utc: m.endDate ?? new Date((ts + 300) * 1000).toISOString(),
        up_price: up,
        down_price: down,
        liquidity: Number(m.liquidity ?? "0"),
        accepting_orders: m.acceptingOrders ?? true,
      };
    } catch {
      /* network miss on one slug — try the next window */
    }
  }
  return null;
}

export interface PluginRail {
  venue: "polymarket-updown";
  executes_via: "okx polymarket-plugin (plugin-store) + the caller's own OKX agentic wallet";
  market: UpdownMarket;
  outcome: "Up" | "Down";
  // The exact command the buyer's agent runs. The plugin enforces its own
  // safety gates (paper-mode default, typed live-mode confirmation, previews).
  command: string;
  note: string;
}

/** Construct the plugin-rail instruction. side yes → Up, no → Down. */
export function buildPluginRail(market: UpdownMarket, side: "yes" | "no", usd: number): PluginRail {
  const outcome = side === "yes" ? "Up" : "Down";
  return {
    venue: "polymarket-updown",
    executes_via: "okx polymarket-plugin (plugin-store) + the caller's own OKX agentic wallet",
    market,
    outcome,
    command: `polymarket-plugin buy --market-id ${market.condition_id} --outcome ${outcome.toLowerCase()} --amount ${usd}`,
    note:
      `On this venue the sides are Up/Down: your '${side}' maps to ${outcome}. ` +
      "The plugin runs on YOUR wallet with its own confirmation gates (paper-mode default, typed live-mode switch, preview before every order).",
  };
}
