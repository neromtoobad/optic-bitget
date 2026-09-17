import "dotenv/config";

function num(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v === undefined || v === "" ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Which exchange kit this instance is built on. OPTIC's engine is one thing
 * (narrative → attention → per-venue read → divergence → verdict + card); the
 * lenses are data adapters. `bitget` is the Bitget AI edition: Bitget's public
 * USDT-FUTURES market data — where tokenized US stocks (rToken) trade as
 * perpetuals — plus bitget-signal's research Skills as the perception layer.
 * `cex` is the CEX Agent OS edition (CEX MCP Server, CEX Web3
 * APIs, CEX Wallet prediction markets). Nothing CEX is touched when
 * this is `bitget`, and vice versa.
 */
export type Exchange = "cex" | "bitget";
const exchangeRaw = (process.env.EXCHANGE ?? "bitget").trim().toLowerCase();
export const EXCHANGE: Exchange = exchangeRaw === "cex" ? "cex" : "bitget";

const publicBaseUrl = (process.env.PUBLIC_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");

export const config = {
  port: num("PORT", 3000),
  exchange: EXCHANGE,
  priceUsdt: num("PRICE_USDT", 1),
  readBudgetUsd: num("READ_BUDGET_USD", 0.3),
  databasePath: process.env.DATABASE_PATH ?? "./data/optic.db",
  cardsDir: process.env.CARDS_DIR ?? "./data/cards",
  reelsDir: process.env.REELS_DIR ?? "./data/reels",
  assetsDir: process.env.ASSETS_DIR ?? "./data/assets",
  // Which marketing site this instance serves. Both agents run the same image, so
  // agent-reel sets SITE_DIR=./site-reel while Optic keeps the default.
  siteDir: (process.env.SITE_DIR ?? "./site").replace(/\/+$/, ""),
  publicBaseUrl,
  cacheTtlSeconds: num("CACHE_TTL_SECONDS", 600),
  // Tolerant of casing/whitespace — "True", "TRUE", " true " must not silently
  // leave a live paid endpoint serving free reads.
  paymentsEnforced: (process.env.PAYMENTS_ENFORCED ?? "").trim().toLowerCase() === "true",
  payoutAddress: process.env.PAYOUT_ADDRESS ?? "",
  bitget: {
    // Bitget public REST (v2). Market data is free and unauthenticated; the desk
    // reads USDT-FUTURES, where tokenized US stocks (rToken) trade as perpetuals.
    restBase: (process.env.BITGET_REST_BASE ?? "https://api.bitget.com").replace(/\/+$/, ""),
    // Optional READ-ONLY key for account-scoped reads through Agent Hub. Never a
    // Trade permission: this is a research desk — the trader places the order.
    apiKey: process.env.BITGET_API_KEY ?? "",
    secretKey: process.env.BITGET_SECRET_KEY ?? "",
    passphrase: process.env.BITGET_PASSPHRASE ?? "",
  },
  cex: {
    // CEX MCP Server (Agent OS). Streamable HTTP + OAuth (PKCE, public client,
    // URL-based client id per the "client id metadata document" the server
    // advertises). The metadata document is served by this same service.
    mcpUrl: (process.env.CEX_MCP_URL ?? "https://agent.cex.com/mcp/agentic").replace(/\/+$/, ""),
    oauthClientMetadataUrl: process.env.CEX_OAUTH_CLIENT_METADATA_URL ?? `${publicBaseUrl}/.well-known/oauth-client.json`,
    // Guards the one-time "connect this server to CEX" route.
    adminToken: process.env.ADMIN_TOKEN ?? "",
    // Optional explicit tool map for the MCP server ({"ticker":"tool_name",…})
    // — discovery by name/description works without it; this is an override.
    mcpToolMap: process.env.CEX_MCP_TOOL_MAP ?? "",
    // B402 — CEX x402 facilitator (BSC USDT settlement). Optional; without a
    // key the CEX edition runs with payments off.
    b402ApiKey: process.env.B402_API_KEY ?? "",
    b402BaseUrl: (process.env.B402_BASE_URL ?? "").replace(/\/+$/, ""),
    payoutAddressBsc: process.env.PAYOUT_ADDRESS_BSC ?? process.env.PAYOUT_ADDRESS ?? "",
  },
  // Any OpenAI-compatible chat endpoint — Bitget's hackathon Qwen gateway
  // (https://hackathon.bitgetops.com/v1, model qwen3.8-max) is the intended one.
  // Tried first when configured; Venice and Claude remain as fallbacks.
  openaiCompat: {
    baseUrl: (process.env.OPENAI_COMPAT_BASE_URL ?? "").replace(/\/+$/, ""),
    apiKey: process.env.OPENAI_COMPAT_API_KEY ?? "",
    model: process.env.OPENAI_COMPAT_MODEL ?? "qwen3.8-max",
  },
  veniceApiKey: process.env.VENICE_API_KEY ?? "",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
};
