import type { Context, Next } from "hono";
import { OKXFacilitatorClient } from "@okxweb3/x402-core";
import {
  FacilitatorResponseError,
  x402HTTPResourceServer,
  x402ResourceServer,
} from "@okxweb3/x402-core/server";
import type { HTTPAdapter, HTTPRequestContext, RoutesConfig } from "@okxweb3/x402-core/server";
import { ExactEvmScheme } from "@okxweb3/x402-evm/exact/server";
import { AggrDeferredEvmScheme } from "@okxweb3/x402-evm/deferred/server";
import { config } from "../config.js";
import { db } from "../db.js";

// X Layer — zero gas, USDT settlement, same chain as OPTIC's ASP identity (#4380).
const NETWORK = "eip155:196" as const;

// The marketplace service lineup — each path is a distinct x402-gated service.
// Cheap data services (~$0 cost) drive order volume; premium reads carry research/LLM cost.
export const PAID_ROUTES: Array<{ path: string; price: number; description: string; mode?: import("../pipeline/index.js").ForceMode }> = [
  { path: "/v1/read", price: 0.5, description: "Optic AI cross-venue market read: verdict JSON + shareable card" },
  { path: "/v1/edge", price: 0.5, description: "Optic AI edge radar: today's mispriced markets, research vs price", mode: "edge" },
  { path: "/v1/daily", price: 0.5, description: "Optic AI daily alpha: today's research-backed picks", mode: "daily" },
  { path: "/v1/rug", price: 0.05, description: "Optic AI rug radar: token safety score + red flags", mode: "rug" },
  { path: "/v1/smart-money", price: 0.05, description: "Optic AI smart money: tokens sharp wallets are accumulating", mode: "smartmoney" },
  { path: "/v1/timing", price: 0.05, description: "Optic AI narrative timing: early vs late lifecycle for any token", mode: "timing" },
  { path: "/v1/stocks", price: 0.5, description: "Optic AI stocks desk: cross-venue read on a stock — OKX tokenized share (xStock) + equity research + prediction markets", mode: "stocks" },
  { path: "/v1/touchgrass", price: 0.1, description: "TouchGrass onchain wellness: wallet behavior patterns, 0-100 score, personalized touch-grass protocol + shareable card", mode: "touchgrass" },
  { path: "/v1/pulse", price: 0.05, description: "Optic AI pulse: the live 5-minute market pulse for BTC, ETH and SOL — the same up-or-down window priced on two venues (OKX event contracts and Polymarket), with both prices and the cross-venue divergence in points.\nProvide: nothing — POST with an empty body returns the current pulse for all covered coins." },
  // Ticket Desk — order CONSTRUCTION, never execution: resolves the caller's chosen
  // event contract, checks the live book, returns the exact order payload. The caller
  // submits it with their own OKX API key; no trade key ever touches this server.
  { path: "/v1/ticket", price: 0.1, description: "Optic AI ticket desk: turns a decided position into a ready-to-submit OKX event-contract order (USDT-settled) — resolves the live contract, reads the order book, sizes the order and returns the exact order payload for the caller's own OKX API key.\nProvide: 1. the event in plain words (e.g. BTC above 60000 today); 2. side (yes or no); 3. USDT size; optional limit price." },
];

/** Header the read handler sets so settlement can attach the tx to the read row. */
export const READ_ID_HEADER = "x-optic-read-id";
/** Same, for a paid ticket — settlement records the tx on event_ticket. */
export const TICKET_ID_HEADER = "x-optic-ticket-id";
/** Same, for a paid pulse — settlement records the tx on pulse_log. */
export const PULSE_ID_HEADER = "x-optic-pulse-id";

/** Hono implementation of the SDK's HTTPAdapter (mirrors ExpressAdapter). */
class HonoAdapter implements HTTPAdapter {
  constructor(private readonly c: Context, private readonly parsedBody: unknown) {}
  getHeader(name: string): string | undefined {
    return this.c.req.header(name) ?? undefined;
  }
  getMethod(): string {
    return this.c.req.method;
  }
  getPath(): string {
    return new URL(this.c.req.url).pathname;
  }
  getUrl(): string {
    return this.c.req.url;
  }
  getAcceptHeader(): string {
    return this.c.req.header("Accept") ?? "";
  }
  getUserAgent(): string {
    return this.c.req.header("User-Agent") ?? "";
  }
  getQueryParams(): Record<string, string | string[]> {
    return this.c.req.queries() as Record<string, string | string[]>;
  }
  getQueryParam(name: string): string | string[] | undefined {
    return this.c.req.query(name);
  }
  getBody(): unknown {
    return this.parsedBody;
  }
}

function instructionsToResponse(response: {
  status: number;
  headers: Record<string, string>;
  body?: unknown;
  isHtml?: boolean;
}): Response {
  const headers = new Headers(response.headers);
  if (response.isHtml) {
    headers.set("Content-Type", "text/html; charset=utf-8");
    return new Response(String(response.body ?? ""), { status: response.status, headers });
  }
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(response.body ?? {}), { status: response.status, headers });
}

// OKX's listing-time "x402 verification" needs each accepts entry to fully
// describe the settlement token in `extra`: `symbol` (which token — USDT0's
// address 0x779ded… is NOT in OKX's by-address USDT/USDG registry, so the symbol
// is how it's identified), `transferMethod` ("eip3009" — how to settle it), plus
// `name`/`version` for the EIP-712 domain and `decimals` for price resolution.
// The stock x402 SDK emits only {name, version}; an APPROVED reference agent
// (Onchain Data Explorer, same USDT0 asset) emits {name, version, symbol,
// transferMethod}. We enrich the emitted 402 challenge to match.
//
// All of this goes ONLY inside `extra`, never in the base object. The facilitator's
// requirement matcher deep-equals the base (everything except `extra`) and only
// checks the SERVER's extra keys against the buyer — so surplus extra keys echoed
// by the buyer are ignored and still match, whereas a new base field would break
// the match ("No matching payment requirements"). Buyer signs EIP-3009 over
// from/to/value/nonce (never these), so settlement is unaffected (proven live).
const SETTLEMENT_EXTRA: Record<string, unknown> = {
  symbol: "USDT",
  transferMethod: "eip3009",
  decimals: 6,
};

function injectAssetDecimals(response: {
  status: number;
  headers: Record<string, string>;
  body?: unknown;
  isHtml?: boolean;
}): typeof response {
  const headers = { ...response.headers };
  const patchAccepts = (obj: unknown): boolean => {
    if (!obj || typeof obj !== "object") return false;
    // Force the resource URL to https — Railway terminates TLS and forwards
    // http internally, so the SDK stamps an http:// resource.url that a security-
    // conscious verifier can reject. resource is not part of the accepts entry the
    // matcher compares, so rewriting it is settlement-safe.
    const resource = (obj as { resource?: { url?: unknown } }).resource;
    if (resource && typeof resource.url === "string" && resource.url.startsWith("http://")) {
      resource.url = "https://" + resource.url.slice("http://".length);
    }
    const accepts = (obj as { accepts?: unknown }).accepts;
    if (!Array.isArray(accepts)) return false;
    for (const a of accepts) {
      if (a && typeof a === "object") {
        const entry = a as Record<string, unknown>;
        if (entry.extra && typeof entry.extra === "object") {
          const extra = entry.extra as Record<string, unknown>;
          for (const [k, v] of Object.entries(SETTLEMENT_EXTRA)) {
            if (extra[k] === undefined) extra[k] = v;
          }
        }
      }
    }
    return true;
  };

  // The challenge rides in the base64 PAYMENT-REQUIRED header (and, defensively,
  // the JSON body if a server variant echoes it there).
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === "payment-required") {
      try {
        const decoded = JSON.parse(Buffer.from(headers[key], "base64").toString("utf8"));
        if (patchAccepts(decoded)) headers[key] = Buffer.from(JSON.stringify(decoded)).toString("base64");
      } catch {
        /* leave the header untouched if it isn't decodable JSON */
      }
    }
  }
  let body = response.body;
  if (body && typeof body === "object") {
    const clone = JSON.parse(JSON.stringify(body));
    if (patchAccepts(clone)) body = clone;
  }
  return { ...response, headers, body };
}

// USDT0 on X Layer — the settlement asset. The full accepts `extra` an approved
// OKX A2MCP agent advertises (name/version for EIP-712, symbol/transferMethod to
// identify + route the token, decimals for price resolution).
const SETTLEMENT_ASSET = "0x779ded0c9e1022225f8e0630b35a9b54be713736";
const SETTLEMENT_FULL_EXTRA = { name: "USD₮0", version: "1", symbol: "USDT", transferMethod: "eip3009", decimals: 6 } as const;

/**
 * Build the standard 402 challenge for an UNPAID request directly — no facilitator
 * call, no SDK init. This is what OKX's x402 validation probes, so it must ALWAYS
 * succeed: a cold start, a Railway redeploy, or a transient facilitator outage must
 * never turn an unpaid request into a 502. The bytes are identical to what the SDK
 * + injectAssetDecimals emit (base fields match the SDK's canonical requirements, so
 * a buyer paying against this challenge still settles through the SDK path unchanged).
 */
function build402ForPath(path: string): Response | null {
  const route = PAID_ROUTES.find((r) => r.path === path);
  if (!route) return null;
  const amount = String(Math.round(route.price * 1_000_000)); // 6-decimal USDT0
  const entry = (scheme: "exact" | "aggr_deferred") => ({
    scheme,
    network: NETWORK,
    amount,
    asset: SETTLEMENT_ASSET,
    payTo: config.payoutAddress,
    maxTimeoutSeconds: 300,
    extra: { ...SETTLEMENT_FULL_EXTRA },
  });
  const challenge = {
    x402Version: 2,
    error: "Payment required",
    resource: { url: `${config.publicBaseUrl}${path}`, description: route.description, mimeType: "application/json" },
    accepts: [entry("exact"), entry("aggr_deferred")],
  };
  const header = Buffer.from(JSON.stringify(challenge)).toString("base64");
  return new Response("{}", {
    status: 402,
    headers: { "content-type": "application/json", "PAYMENT-REQUIRED": header },
  });
}

/**
 * Real x402 seller middleware (Phase 4), ported from @okxweb3/x402-express to
 * Hono. Unpaid POSTs get the 402 PAYMENT-REQUIRED challenge; signed requests
 * are verified BEFORE the pipeline runs and settled AFTER it succeeds — a read
 * that fails is never charged. The facilitator (OKX Broker) does all on-chain
 * work; we hold no keys beyond the payout address.
 */
export function createX402Middleware(): (c: Context, next: Next) => Promise<Response | void> {
  if (!config.paymentsEnforced) {
    return async (_c, next) => next();
  }
  if (!config.payoutAddress) {
    throw new Error("PAYMENTS_ENFORCED=true requires PAYOUT_ADDRESS");
  }

  const facilitator = new OKXFacilitatorClient({
    apiKey: config.okx.apiKey,
    secretKey: config.okx.secretKey,
    passphrase: config.okx.passphrase,
  });
  // Register BOTH schemes. OKX's listing x402 verification (and A2MCP pay-per-call)
  // expects the deferred scheme offered alongside exact — every approved OKX A2MCP
  // agent advertises exact + aggr_deferred. The facilitator settles aggr_deferred
  // asynchronously (status=success immediately, no polling). Buyers' `payment pay`
  // auto-selects exact first, so existing settlement is unchanged.
  const resourceServer = new x402ResourceServer(facilitator)
    .register(NETWORK, new ExactEvmScheme())
    .register(NETWORK, new AggrDeferredEvmScheme());
  const routes: RoutesConfig = {
    ...Object.fromEntries(
      PAID_ROUTES.map((r) => [
        `POST ${r.path}`,
        {
          accepts: [
            { scheme: "exact", network: NETWORK, payTo: config.payoutAddress, price: `$${r.price}` },
            { scheme: "aggr_deferred", network: NETWORK, payTo: config.payoutAddress, price: `$${r.price}` },
          ],
          description: r.description,
          mimeType: "application/json",
        },
      ])
    ),
  };
  const httpServer = new x402HTTPResourceServer(resourceServer, routes);

  let initialized = false;
  let initPromise: Promise<void> | null = null;
  const ensureInitialized = async () => {
    if (initialized) return;
    initPromise ??= httpServer.initialize();
    try {
      await initPromise;
      initialized = true;
    } catch (err) {
      initPromise = null;
      throw err;
    }
  };
  // Warm the facilitator at boot so the first PAID request is fast (retry a few
  // times through transient blips). Unpaid requests never wait on this.
  void (async () => {
    for (let i = 0; i < 5 && !initialized; i++) {
      try {
        await ensureInitialized();
      } catch {
        await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
      }
    }
  })();

  return async (c, next) => {
    const paymentHeader = c.req.header("payment-signature") ?? c.req.header("x-payment");

    // UNPAID request → emit the standard 402 challenge directly, with NO dependency
    // on the facilitator or its init. Guarantees an unpaid probe (OKX's x402 check)
    // ALWAYS gets a conformant 402, even mid-cold-start or during a facilitator hiccup.
    if (!paymentHeader) {
      const resp = build402ForPath(new URL(c.req.url).pathname);
      if (resp) {
        c.res = resp;
        return;
      }
    }

    const parsedBody = await c.req.raw
      .clone()
      .json()
      .catch(() => undefined);
    const adapter = new HonoAdapter(c, parsedBody);
    const context: HTTPRequestContext = {
      adapter,
      path: adapter.getPath(),
      method: c.req.method,
      paymentHeader,
    };

    if (!httpServer.requiresPayment(context)) return next();

    try {
      await ensureInitialized();
    } catch (err) {
      if (err instanceof FacilitatorResponseError) {
        return c.json({ error: err.message }, 502);
      }
      throw err;
    }

    let result;
    try {
      result = await httpServer.processHTTPRequest(context);
    } catch (err) {
      if (err instanceof FacilitatorResponseError) {
        return c.json({ error: err.message }, 502);
      }
      throw err;
    }

    if (result.type === "no-payment-required") return next();
    if (result.type === "payment-error") {
      c.res = instructionsToResponse(injectAssetDecimals(result.response));
      return;
    }

    // payment-verified: run the read, settle only on success.
    await next();

    if (c.res.status >= 400) return; // failed read → buyer keeps their money

    const responseBody = Buffer.from(await c.res.clone().arrayBuffer());
    try {
      const settle = await httpServer.processSettlement(
        result.paymentPayload,
        result.paymentRequirements,
        result.declaredExtensions,
        { request: context, responseBody, responseHeaders: {} }
      );

      if (!settle.success) {
        c.res = instructionsToResponse(settle.response);
        return;
      }

      // Attach settlement headers (PAYMENT-RESPONSE) + record the tx on the read/ticket.
      const readId = c.res.headers.get(READ_ID_HEADER);
      if (readId && settle.transaction) {
        db.prepare("UPDATE reads SET paid_tx = ? WHERE id = ?").run(settle.transaction, readId);
        console.log(`read ${readId} settled — tx ${settle.transaction} (${settle.status ?? "success"})`);
      }
      const ticketId = c.res.headers.get(TICKET_ID_HEADER);
      if (ticketId && settle.transaction) {
        const { attachTicketTx } = await import("../ticket/index.js");
        attachTicketTx(ticketId, settle.transaction);
        console.log(`ticket ${ticketId} settled — tx ${settle.transaction} (${settle.status ?? "success"})`);
      }
      const pulseId = c.res.headers.get(PULSE_ID_HEADER);
      if (pulseId && settle.transaction) {
        const { attachPulseTx } = await import("../pulse.js");
        attachPulseTx(pulseId, settle.transaction);
        console.log(`pulse ${pulseId} settled — tx ${settle.transaction} (${settle.status ?? "success"})`);
      }
      const headers = new Headers(c.res.headers);
      headers.delete(READ_ID_HEADER);
      headers.delete(TICKET_ID_HEADER);
      headers.delete(PULSE_ID_HEADER);
      for (const [k, v] of Object.entries(settle.headers)) headers.set(k, v);
      c.res = new Response(c.res.body, { status: c.res.status, headers });
    } catch (err) {
      if (err instanceof FacilitatorResponseError) {
        c.res = c.newResponse(JSON.stringify({ error: err.message }), 502, {
          "Content-Type": "application/json",
        });
        return;
      }
      console.error("settlement error:", err);
      c.res = c.newResponse(JSON.stringify({ error: "settlement failed" }), 402, {
        "Content-Type": "application/json",
      });
    }
  };
}
