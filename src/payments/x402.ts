import type { Context, Next } from "hono";
import { config } from "../config.js";

// PAYMENTS — the seller side.
//
// The Binance edition ships with settlement DISABLED. B402 (Binance Pay's x402
// profile) requires merchant onboarding that this deployment does not yet hold,
// and the honest thing to do is say so rather than advertise a payment challenge
// no facilitator can settle. `PAYMENTS_ENFORCED` stays false; every paid route
// is served free and the service is transparent about it on /v1/health.
//
// PAID_ROUTES therefore does double duty: it is the service catalogue that
// registers the routes and prices them for the marketplace listing, and it is
// what the middleware will charge against once merchant credentials exist.

/** The service lineup — each path is a distinct priced service. */
export const PAID_ROUTES: Array<{ path: string; price: number; description: string; mode?: import("../pipeline/index.js").ForceMode }> = [
  { path: "/v1/read", price: 0.5, description: "Optic AI cross-venue market read: verdict JSON + shareable card" },
  { path: "/v1/edge", price: 0.5, description: "Optic AI edge radar: today's mispriced markets, research vs price", mode: "edge" },
  { path: "/v1/daily", price: 0.5, description: "Optic AI daily alpha: today's research-backed picks", mode: "daily" },
  { path: "/v1/rug", price: 0.05, description: "Optic AI rug radar: token safety score + red flags", mode: "rug" },
  { path: "/v1/smart-money", price: 0.05, description: "Optic AI smart money: tokens sharp wallets are accumulating", mode: "smartmoney" },
  { path: "/v1/timing", price: 0.05, description: "Optic AI narrative timing: early vs late lifecycle for any token", mode: "timing" },
  { path: "/v1/stocks", price: 0.5, description: "Optic AI stocks desk: cross-market read on a stock — the exchange-listed tokenized share on-chain + equity research + prediction markets", mode: "stocks" },
  { path: "/v1/touchgrass", price: 0.1, description: "TouchGrass onchain wellness: wallet behavior patterns, 0-100 score, personalized touch-grass protocol + shareable card", mode: "touchgrass" },
  { path: "/v1/pulse", price: 0.05, description: "Optic AI pulse: the live short-horizon market pulse for BTC, ETH and SOL — the Up/Down window priced on Binance Wallet prediction markets, set against the live Binance spot tape, with the gap in points.\nProvide: nothing — POST with an empty body returns the current pulse for all covered coins." },
  // Ticket Desk — order CONSTRUCTION, never execution: resolves the caller's chosen
  // market, sizes the position and returns the exact Agentic Wallet commands. The
  // caller runs them on their own wallet; no trade key ever touches this server.
  { path: "/v1/ticket", price: 0.1, description: "Optic AI ticket desk: turns a decided position into a ready-to-place Binance Wallet prediction-market order (USDT-settled) — resolves the live market, reads the priced outcome, sizes the position and returns the exact Agentic Wallet commands for the caller's own wallet.\nProvide: 1. the market in plain words (e.g. Fed decision in September no change); 2. side (yes or no); 3. USDT size; optional limit price." },
];

/** Header the read handler sets so settlement can attach the tx to the read row. */
export const READ_ID_HEADER = "x-optic-read-id";
/** Same, for a paid ticket — settlement records the tx on event_ticket. */
export const TICKET_ID_HEADER = "x-optic-ticket-id";
/** Same, for a paid pulse — settlement records the tx on pulse_log. */
export const PULSE_ID_HEADER = "x-optic-pulse-id";

/**
 * Seller middleware. With settlement disabled this is a pass-through; every paid
 * route answers for free. Turning `PAYMENTS_ENFORCED` on without a settlement
 * rail wired would advertise a challenge nothing can settle, so it fails loudly
 * at startup instead of half-working in production.
 */
export function createX402Middleware(): (c: Context, next: Next) => Promise<Response | void> {
  if (!config.paymentsEnforced) {
    return async (_c, next) => next();
  }
  throw new Error(
    "PAYMENTS_ENFORCED=true, but no settlement rail is wired in this edition. " +
      "B402 requires Binance Pay merchant credentials; leave PAYMENTS_ENFORCED unset until they exist."
  );
}
