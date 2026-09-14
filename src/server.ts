import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { config } from "./config.js";
import { runRead } from "./pipeline/index.js";
import { createX402Middleware, READ_ID_HEADER, TICKET_ID_HEADER, PULSE_ID_HEADER, PAID_ROUTES } from "./payments/x402.js";
import type { ForceMode } from "./pipeline/index.js";
import { scoreboard, resolveDue, verifyChain } from "./desk/ledger.js";
import { getRead } from "./db.js";
import { BudgetExceededError } from "./pipeline/budget.js";

const app = new Hono<{ Variables: { paidTx?: string } }>();

// Marketing site — served from the same origin as the API, so the page's live
// track-record fetch and card links need no CORS. optic.xyz-style custom domains
// attach to this same service later without touching the registered endpoints.
app.get("/", serveStatic({ path: `${config.siteDir}/index.html` }));
// Agent-facing API docs. Served from the same origin as the endpoints they
// describe, so every example on the page is copy-pasteable as-is. Agent Reel's
// site carries its reference inline, so /docs just anchors into the one page.
if (config.siteDir === "./site") {
  app.get("/docs", serveStatic({ path: "./site/docs.html" }));
} else {
  app.get("/docs", (c) => c.redirect("/#docs", 302));
}
app.use("/assets/*", serveStatic({ root: config.siteDir }));

app.get("/v1/health", (c) =>
  c.json({
    ok: true,
    service: `optic-${config.exchange}`,
    exchange: config.exchange,
    // Free, non-secret operational signal — lets us confirm payment enforcement
    // without POSTing (a POST runs a paid read when payments are off).
    payments_enforced: config.paymentsEnforced,
    price_usdt: config.priceUsdt,
    ts: new Date().toISOString(),
  })
);

// Free, public track record — OPTIC's real hit rate on surfaced prediction reads,
// scored as markets resolve on-chain. Lazily resolves any newly-closed markets first.
// ── The desk's public scoreboard ───────────────────────────────────────
// Every verdict the desk issued, graded against what the perpetual did once
// its horizon elapsed. Free, no login: this page IS the validation data.
app.get("/v1/scoreboard", async (c) => {
  await resolveDue().catch((err) => console.error(`scoreboard resolve: ${err}`));
  return c.json(scoreboard());
});
// Recompute the ledger's hash chain from genesis — anyone can check nothing was edited.
app.get("/v1/scoreboard/verify", (c) => c.json(verifyChain()));

app.get("/v1/track-record", async (c) => {
  const { resolveOpenPicks, trackRecord } = await import("./track/picks.js");
  await resolveOpenPicks().catch(() => {});
  const r = trackRecord();
  return c.json({
    ...r,
    note:
      "OPTIC surfaces the market-favored outcome and records how those reads resolve. This is a calibration record, not a claim to beat the market. avg_implied_prob shows how favored the picks were.",
  });
});

// ── OPTIC AS AN MCP SERVER ─────────────────────────────────────────────────
// The second half of the Agent OS workflow: a client that already holds a
// Binance MCP session (Claude Code, ChatGPT, Codex, Cursor, VS Code) adds Optic
// alongside it and passes its Binance tool output straight into optic_read.
//   claude mcp add optic --transport http <PUBLIC_BASE_URL>/mcp
app.all("/mcp", async (c) => {
  if (c.req.method === "OPTIONS") {
    return c.body(null, 204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "content-type, mcp-session-id, mcp-protocol-version, accept, authorization",
      "Access-Control-Expose-Headers": "mcp-session-id",
    });
  }
  const { handleMcpRequest } = await import("./mcp/server.js");
  try {
    return await handleMcpRequest(c.req.raw);
  } catch (err) {
    console.error("/mcp failed:", err);
    return c.json({ jsonrpc: "2.0", error: { code: -32603, message: "internal error" }, id: null }, 500);
  }
});

// ── BINANCE AGENT OS ───────────────────────────────────────────────────────
// Optic is an MCP client of the Binance MCP Server. Binance identifies OAuth
// clients by a metadata document at the client_id URL, which this service hosts.
// One operator authorisation (admin-token gated) binds the deployment; tokens
// live in SQLite and refresh silently. Status is free and public.
app.get("/.well-known/oauth-client.json", async (c) => {
  const { clientMetadataDocument } = await import("./lib/binance/mcp.js");
  return c.json(clientMetadataDocument(), 200, { "Cache-Control": "public, max-age=300" });
});

app.get("/v1/binance/status", async (c) => {
  const { mcpStatus } = await import("./lib/binance/mcp.js");
  const s = await mcpStatus();
  return c.json({
    ...s,
    mcp_url: config.binance.mcpUrl,
    note: "Optic reads Binance market data through the Binance MCP Server when authorised; otherwise the same public numbers come from the Binance API. It never holds trade or transfer scopes.",
  });
});

const adminOk = (token: string | undefined): boolean => !!config.binance.adminToken && token === config.binance.adminToken;

app.get("/v1/binance/oauth/start", async (c) => {
  if (!adminOk(c.req.query("token"))) return c.json({ error: "admin token required" }, 401);
  const { beginAuth } = await import("./lib/binance/mcp.js");
  try {
    const url = await beginAuth(undefined, { force: c.req.query("force") === "1" });
    if (!url) return c.json({ ok: true, note: "already authorised (refresh token valid)" });
    return c.redirect(url, 302);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.get("/v1/binance/oauth/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state") ?? null;
  const oauthErr = c.req.query("error");
  if (oauthErr || !code) return c.text(`authorisation failed: ${oauthErr ?? "no code"} ${c.req.query("error_description") ?? ""}`, 400);
  const { finishAuth, listBinanceTools } = await import("./lib/binance/mcp.js");
  try {
    await finishAuth(code, state);
    const tools = await listBinanceTools();
    return c.text(`Optic is connected to the Binance MCP Server. Tools visible: ${tools?.length ?? 0}. You can close this tab.`);
  } catch (err) {
    return c.text(`authorisation failed: ${(err as Error).message}`, 500);
  }
});

app.post("/v1/binance/disconnect", async (c) => {
  if (!adminOk(c.req.query("token"))) return c.json({ error: "admin token required" }, 401);
  const { disconnectAuth } = await import("./lib/binance/mcp.js");
  disconnectAuth();
  return c.json({ ok: true });
});

// One x402 middleware guards every paid route (per-route pricing in PAID_ROUTES).
const paymentMiddleware = createX402Middleware();

// Modes that need a query param (a token/subject); discovery modes ignore the body.
const NEEDS_QUERY = new Set<ForceMode | "read">(["read", "rug", "timing", "stocks", "touchgrass", "desk"]);

for (const route of PAID_ROUTES) {
  const mode = route.mode; // undefined = full cross-venue read
  const needsQuery = NEEDS_QUERY.has(mode ?? "read");

  // Reel, ticket and pulse are x402-gated (in PAID_ROUTES so the middleware challenges
  // them) but are not market reads — they have their own handlers below.
  if (["/v1/ticket", "/v1/pulse"].includes(route.path)) continue;

  // Paid endpoints are POST-only; GET on a paid route → 405 (Onchain Data Explorer pattern).
  app.get(route.path, (c) => c.json({ error: "use POST" }, 405));

  app.post(route.path, paymentMiddleware, async (c) => {
    let query = "";
    let extras: { city?: string; tz?: string; at?: string } | undefined;
    if (needsQuery) {
      let body: { query?: unknown; token?: unknown; address?: unknown; ticker?: unknown; city?: unknown; tz?: unknown; at?: unknown };
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "invalid JSON body" }, 400);
      }
      // `query` is canonical; token/address/ticker are accepted aliases (buyers send
      // {token, chain} shapes in the wild — a 400 on those is friction, not safety).
      const raw = [body.query, body.token, body.address, body.ticker].find((v) => typeof v === "string" && v.trim());
      query = typeof raw === "string" ? raw.trim() : "";
      if (!query) return c.json({ error: "query is required (a token address, ticker, or subject) — also accepted as 'token', 'address' or 'ticker'" }, 400);
      const maxLen = mode === "desk" ? 500 : 200;
      if (query.length > maxLen) return c.json({ error: `query must be ≤${maxLen} chars` }, 400);
      // Desk replay: rebuild the evidence table as of a past ISO timestamp (a judge-built scenario).
      if (mode === "desk" && typeof body.at === "string" && body.at.trim()) {
        const at = new Date(body.at.trim());
        if (Number.isNaN(at.getTime()) || at.getTime() > Date.now()) return c.json({ error: "at must be an ISO timestamp in the past" }, 400);
        extras = { at: at.toISOString() };
      }
      // TouchGrass personalization: optional city (weather) + IANA timezone.
      if (mode === "touchgrass") {
        extras = {
          city: typeof body.city === "string" ? body.city.trim().slice(0, 60) : undefined,
          tz: typeof body.tz === "string" ? body.tz.trim().slice(0, 60) : undefined,
        };
      }
    } else {
      query = mode ?? "read";
    }

    try {
      const { readId, verdict, costUsd } = await runRead(query, mode ? { forceMode: mode, extras } : {});
      console.log(`${route.path} ${readId} complete — cost ${costUsd.toFixed(4)}`);
      // A non-answer must not settle: rug/timing reads whose core payload is null
      // (unresolvable token, no onchain data) return 404 BEFORE the payment
      // middleware settles — the buyer keeps their money. (A buyer paid 0.05 for
      // risk:null on a valid ERC-20; that must never happen again.)
      const noAnswer =
        (mode === "rug" && (verdict as { risk?: unknown }).risk == null) ||
        (mode === "timing" && (verdict as { timing?: unknown }).timing == null);
      if (noAnswer) return c.json(verdict, 404);
      c.header(READ_ID_HEADER, readId); // settlement middleware attaches tx hash, then strips it
      return c.json(verdict);
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        console.error(`${route.path} failed on budget: ${err.message}`);
        return c.json({ error: "read exceeded cost budget and was aborted; you were not charged" }, 503);
      }
      console.error(`${route.path} failed:`, err);
      return c.json({ error: "read failed" }, 500);
    }
  });
}

app.get("/v1/card/:id", async (c) => {
  const id = c.req.param("id");
  const { cardPath } = await import("./card/render.js");
  const path = cardPath(id);
  if (path) {
    const { readFileSync } = await import("node:fs");
    return c.body(new Uint8Array(readFileSync(path)), 200, {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=31536000, immutable",
    });
  }
  const read = getRead(id);
  if (!read) return c.json({ error: "not found" }, 404);
  return c.json({ id: read.id, status: read.status, card_pending: true });
});

// ── PULSE ──────────────────────────────────────────────────────────────────
// Paid, POST-only, x402-gated. The 5-minute cross-venue read: same up/down window
// priced on Binance Wallet prediction markets against the live spot tape. No body needed.
app.get("/v1/pulse", (c) => c.json({ error: "use POST" }, 405));

app.post("/v1/pulse", paymentMiddleware, async (c) => {
  const { runPulse } = await import("./pulse.js");
  try {
    const verdict = await runPulse();
    if (!verdict.pulse_id) return c.json(verdict, 404); // no open windows → buyer keeps their money
    c.header(PULSE_ID_HEADER, verdict.pulse_id);
    return c.json(verdict);
  } catch (err) {
    console.error("/v1/pulse failed:", err);
    return c.json({ error: "pulse failed" }, 500);
  }
});

// ── TICKET DESK ────────────────────────────────────────────────────────────
// Paid, POST-only, x402-gated. Order CONSTRUCTION only: the caller names the market,
// side and size; the response is the signable payload their own wallet signs. Failures
// (no such market, dead book) return 4xx BEFORE settlement — never a charge for a
// ticket that can't exist.
app.get("/v1/ticket", (c) => c.json({ error: "use POST" }, 405));

app.post("/v1/ticket", paymentMiddleware, async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const query = typeof body.query === "string" ? body.query.trim() : "";
  const side = typeof body.side === "string" ? body.side.trim().toLowerCase() : "";
  const usdt = Number(body.usdt);
  const limit = body.limit === undefined ? undefined : Number(body.limit);

  if (!query || query.length > 300)
    return c.json({ error: "query is required — an event in plain words, e.g. 'BTC above 60000 today' (≤300 chars)" }, 400);
  if (side !== "yes" && side !== "no")
    return c.json({ error: "side must be 'yes' or 'no' — the ticket desk constructs, it never chooses" }, 400);
  if (!Number.isFinite(usdt) || usdt < 1 || usdt > 10_000)
    return c.json({ error: "usdt must be a number between 1 and 10000 (capital to commit)" }, 400);
  if (limit !== undefined && !(limit > 0 && limit < 1))
    return c.json({ error: "limit, when given, must be between 0 and 1" }, 400);

  const { planTicket } = await import("./ticket/index.js");
  try {
    const verdict = await planTicket({ query, side, usdt, limit });
    if (!verdict.ticket) return c.json(verdict, 404); // not constructible → buyer keeps their money
    if (verdict.ticket_id) c.header(TICKET_ID_HEADER, verdict.ticket_id);
    return c.json(verdict);
  } catch (err) {
    console.error("/v1/ticket failed:", err);
    return c.json({ error: "ticket construction failed" }, 500);
  }
});

// Persistence guard: a mounted volume that the data paths don't point into means
// every deploy silently wipes reads, sales records, and served cards (bit us
// Jul 12 — vars were ./data/* while the volume mounts at /data; every posted
// card link died on the next deploy). Loud at boot so it can't regress quietly.
const volumeMount = process.env.RAILWAY_VOLUME_MOUNT_PATH;
if (volumeMount) {
  for (const [name, p] of [["DATABASE_PATH", config.databasePath], ["CARDS_DIR", config.cardsDir], ["REELS_DIR", config.reelsDir], ["ASSETS_DIR", config.assetsDir]] as const) {
    if (!p.startsWith(volumeMount)) {
      console.error(
        `!!! PERSISTENCE WARNING: volume mounted at ${volumeMount} but ${name}=${p} is NOT on it — ` +
          `data will be WIPED on every deploy. Set ${name} to a path under ${volumeMount}.`
      );
    }
  }
}

serve({ fetch: app.fetch, port: config.port }, (info) => {
  // Boot diagnostic: shows exactly what the container saw for the payment flag,
  // so a misconfigured env is obvious in the deploy log (value is not a secret).
  const raw = process.env.PAYMENTS_ENFORCED;
  console.log(
    `OPTIC listening on :${info.port} (payments ${config.paymentsEnforced ? "ENFORCED" : "off — stub"}) ` +
      `[PAYMENTS_ENFORCED=${raw === undefined ? "<unset>" : JSON.stringify(raw)}, payout=${config.payoutAddress ? "set" : "MISSING"}]`
  );
});

// Grade due desk verdicts on a timer so the scoreboard is current even when
// nobody has opened it. unref() keeps the timer from holding the process open.
setInterval(() => resolveDue().catch((err) => console.error(`ledger resolve: ${err}`)), 10 * 60_000).unref();
