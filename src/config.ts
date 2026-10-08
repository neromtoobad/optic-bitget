import "dotenv/config";

function num(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v === undefined || v === "" ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * The exchange kit this instance is built on. OPTIC's engine is one thing; the
 * lenses are data adapters. This is the Bitget AI edition: Bitget's public
 * USDT-FUTURES market data — where tokenized US stocks (rToken) trade as
 * perpetuals — plus bitget-signal's research Skills as the perception layer.
 */
export type Exchange = "bitget";
export const EXCHANGE: Exchange = "bitget";

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
  // Any OpenAI-compatible chat endpoint — Bitget's hackathon Qwen gateway
  // (https://hackathon.bitgetops.com/v1, model qwen3.8-max) is the intended one.
  // Tried first when configured; Venice and Claude remain as fallbacks.
  openaiCompat: {
    baseUrl: (process.env.OPENAI_COMPAT_BASE_URL ?? "").replace(/\/+$/, ""),
    apiKey: process.env.OPENAI_COMPAT_API_KEY ?? "",
    model: process.env.OPENAI_COMPAT_MODEL ?? "qwen3.8-max",
  },
  // Optional token shown on the site under the headline: contract address, ticker,
  // chain label and a link. Unset TOKEN_CA and the strip simply doesn't render.
  token: {
    ca: (process.env.TOKEN_CA ?? "").trim(),
    symbol: (process.env.TOKEN_SYMBOL ?? "").trim().replace(/^\$/, ""),
    chain: (process.env.TOKEN_CHAIN ?? "").trim(),
    url: (process.env.TOKEN_URL ?? "").trim(),
  },
  veniceApiKey: process.env.VENICE_API_KEY ?? "",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
};
