import type { Context, Next } from "hono";
import { config } from "../config.js";

// PAYMENTS — the seller side.
//
// This edition ships with settlement DISABLED: no merchant rail is wired, and the
// honest thing to do is say so rather than advertise a payment challenge nothing
// can settle. `PAYMENTS_ENFORCED` stays false; every route is served free and the
// service is transparent about it on /v1/health.
//
// PAID_ROUTES is the service catalogue: it registers the routes and prices them,
// and it is what the middleware would charge against once a rail exists.

/** The service lineup — each path is a distinct priced service. */
export const PAID_ROUTES: Array<{ path: string; price: number; description: string; mode: import("../pipeline/index.js").ForceMode }> = [
  { path: "/v1/desk", price: 0.5, description: "Optic research desk: stress-test a trader's idea about a Bitget rToken US-stock perpetual against the perp's own history and every market that prices the company — cited Bull/Bear debate, capped judge, coverage-capped confidence, may abstain, never trades; every verdict ledgered and graded on the public scoreboard", mode: "desk" },
  { path: "/v1/read", price: 0.5, description: "Alias of /v1/desk", mode: "desk" },
  { path: "/v1/stocks", price: 0.5, description: "Optic stocks check: one company across markets — Bitget's rToken perpetual, equity research and prediction markets", mode: "stocks" },
  { path: "/v1/touchgrass", price: 0.1, description: "TouchGrass onchain wellness: wallet behavior patterns, 0-100 score, personalized touch-grass protocol + shareable card", mode: "touchgrass" },
];

/** Header the read handler sets so settlement can attach the tx to the read row. */
export const READ_ID_HEADER = "x-optic-read-id";

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
    "PAYMENTS_ENFORCED=true, but no settlement rail is wired in this edition; " +
      "leave PAYMENTS_ENFORCED unset until one exists."
  );
}
