import "dotenv/config";

function num(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v === undefined || v === "" ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Which exchange kit this instance is built on. OPTIC's engine is one thing
 * (narrative → attention → per-venue read → divergence → verdict + card); the
 * lenses are data adapters. `okx` is the OKX.AI listing (OnchainOS Market API,
 * X Layer x402). `cex` is the CEX Agent OS edition: CEX MCP Server
 * (CEX spot + perps), CEX Web3 APIs (the same endpoints the Skills Hub
 * skills call), the WC assistant / prediction markets, and B402 for payments.
 * Nothing OKX is touched when this is `cex`, and vice versa.
 */
export type Exchange = "okx" | "cex";
const exchangeRaw = (process.env.EXCHANGE ?? "okx").trim().toLowerCase();
export const EXCHANGE: Exchange = exchangeRaw === "cex" ? "cex" : "okx";

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
  okx: {
    apiKey: process.env.OKX_API_KEY ?? "",
    secretKey: process.env.OKX_SECRET_KEY ?? "",
    passphrase: process.env.OKX_PASSPHRASE ?? "",
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
  veniceApiKey: process.env.VENICE_API_KEY ?? "",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
};
