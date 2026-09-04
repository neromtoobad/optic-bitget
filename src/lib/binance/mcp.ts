import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { auth, UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { config } from "../../config.js";
import { kvGet, kvSet, kvDel } from "../../db.js";
import type { BudgetGuard } from "../../pipeline/budget.js";

// Binance MCP Server client — Optic is an MCP *client* of Binance Agent OS.
//
// The server (https://agent.binance.com/mcp/agentic) speaks Streamable HTTP and
// gates every call behind OAuth: PKCE, public client, and a URL-based client id
// (the authorization server advertises client_id_metadata_document_supported).
// This service hosts that client-id document itself (/.well-known/oauth-client.json)
// and stores the resulting tokens in SQLite, so one operator authorisation binds
// the deployment to a Binance account; the SDK refreshes silently after that.
//
// Only the *market data* scope is ever needed for the CEX lens. Optic never asks
// for the Trade or Transfer scopes — it reads the exchange, it does not act on it.

const KV = {
  tokens: "binance_mcp:tokens",
  verifier: "binance_mcp:verifier",
  state: "binance_mcp:state",
  client: "binance_mcp:client",
  redirect: "binance_mcp:redirect",
} as const;

export const LOCAL_CALLBACK = "http://127.0.0.1:8976/callback";
export const publicCallbackUrl = (): string => `${config.publicBaseUrl}/v1/binance/oauth/callback`;

/** The client-id metadata document (SEP-991 / CIMD). Served at the client_id URL. */
export function clientMetadataDocument(): OAuthClientMetadata & { client_id: string } {
  return {
    client_id: config.binance.oauthClientMetadataUrl,
    client_name: "Optic for Binance",
    client_uri: config.publicBaseUrl,
    redirect_uris: [publicCallbackUrl(), LOCAL_CALLBACK],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  };
}

class SqliteOAuthProvider implements OAuthClientProvider {
  pendingAuthorizationUrl: URL | null = null;
  constructor(private readonly redirect: string) {}
  get redirectUrl(): string {
    return this.redirect;
  }
  get clientMetadataUrl(): string {
    return config.binance.oauthClientMetadataUrl;
  }
  get clientMetadata(): OAuthClientMetadata {
    const { client_id: _omit, ...metadata } = clientMetadataDocument();
    void _omit;
    return metadata;
  }
  state(): string {
    const s = randomBytes(16).toString("hex");
    kvSet(KV.state, s);
    return s;
  }
  clientInformation(): OAuthClientInformationMixed | undefined {
    return kvGet<OAuthClientInformationMixed>(KV.client);
  }
  saveClientInformation(info: OAuthClientInformationMixed): void {
    kvSet(KV.client, info);
  }
  tokens(): OAuthTokens | undefined {
    return kvGet<OAuthTokens>(KV.tokens);
  }
  saveTokens(tokens: OAuthTokens): void {
    kvSet(KV.tokens, { ...tokens, obtained_at: Date.now() });
  }
  redirectToAuthorization(url: URL): void {
    this.pendingAuthorizationUrl = url;
  }
  saveCodeVerifier(v: string): void {
    kvSet(KV.verifier, v);
  }
  codeVerifier(): string {
    const v = kvGet<string>(KV.verifier);
    if (!v) throw new Error("binance mcp: no pending PKCE verifier — start the authorisation again");
    return v;
  }
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "all" || scope === "tokens") kvDel(KV.tokens);
    if (scope === "all" || scope === "client") kvDel(KV.client);
    if (scope === "all" || scope === "verifier") kvDel(KV.verifier);
    if (scope === "all") resetClient();
  }
}

// ── authorisation flow ────────────────────────────────────────────────

/**
 * Start the operator authorisation. Returns the Binance authorize URL to send the
 * browser to, or null when a stored refresh token already yields a session.
 */
export async function beginAuth(redirect = publicCallbackUrl(), opts: { force?: boolean } = {}): Promise<string | null> {
  if (!/^https:\/\/.+\/.+/.test(config.binance.oauthClientMetadataUrl)) {
    throw new Error(
      `binance mcp: BINANCE_OAUTH_CLIENT_METADATA_URL must be an https URL with a path (got ${config.binance.oauthClientMetadataUrl}). ` +
        "Binance identifies this client by that document, so point it at the deployed /.well-known/oauth-client.json."
    );
  }
  const provider = new SqliteOAuthProvider(redirect);
  kvSet(KV.redirect, redirect);
  provider.invalidateCredentials("client"); // client id is derived from the metadata URL; never reuse a stale one
  if (opts.force) provider.invalidateCredentials("tokens");
  resetClient();
  const result = await auth(provider, { serverUrl: config.binance.mcpUrl });
  if (result === "AUTHORIZED") return null;
  if (!provider.pendingAuthorizationUrl) throw new Error("binance mcp: authorization server did not produce a redirect");
  return provider.pendingAuthorizationUrl.toString();
}

/** Complete the flow with the code from the callback. Verifies the CSRF state. */
export async function finishAuth(code: string, state: string | null): Promise<void> {
  const expected = kvGet<string>(KV.state);
  if (!expected || !state || state !== expected) throw new Error("binance mcp: OAuth state mismatch — start the authorisation again");
  const redirect = kvGet<string>(KV.redirect) ?? publicCallbackUrl();
  const provider = new SqliteOAuthProvider(redirect);
  const result = await auth(provider, { serverUrl: config.binance.mcpUrl, authorizationCode: code });
  if (result !== "AUTHORIZED") throw new Error(`binance mcp: unexpected auth result ${result}`);
  kvDel(KV.state);
  kvDel(KV.verifier);
  resetClient();
}

export function disconnectAuth(): void {
  new SqliteOAuthProvider(publicCallbackUrl()).invalidateCredentials("all");
}

// ── session ───────────────────────────────────────────────────────────

let clientPromise: Promise<Client | null> | null = null;
let lastError: string | null = null;
let toolsCache: { tools: McpTool[]; at: number } | null = null;
const TOOLS_TTL_MS = 10 * 60_000;

function resetClient(): void {
  clientPromise?.then((c) => c?.close().catch(() => undefined));
  clientPromise = null;
  toolsCache = null;
}

export function hasStoredTokens(): boolean {
  return kvGet<OAuthTokens>(KV.tokens) !== undefined;
}

/** A connected client, or null when the deployment is not authorised (never throws). */
export async function getBinanceMcp(): Promise<Client | null> {
  if (!hasStoredTokens()) return null;
  if (!clientPromise) {
    clientPromise = (async () => {
      const provider = new SqliteOAuthProvider(kvGet<string>(KV.redirect) ?? publicCallbackUrl());
      const transport = new StreamableHTTPClientTransport(new URL(config.binance.mcpUrl), { authProvider: provider });
      const client = new Client({ name: "optic-binance", version: "1.0.0" });
      transport.onclose = () => {
        clientPromise = null;
        toolsCache = null;
      };
      try {
        await client.connect(transport);
        lastError = null;
        return client;
      } catch (err) {
        lastError = err instanceof UnauthorizedError ? "unauthorized — reconnect via /v1/binance/oauth/start" : String(err);
        console.error(`binance mcp connect: ${lastError}`);
        clientPromise = null;
        return null;
      }
    })();
  }
  return clientPromise;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: { properties?: Record<string, { type?: string; description?: string; enum?: unknown[] }>; required?: string[] };
}

export async function listBinanceTools(): Promise<McpTool[] | null> {
  if (toolsCache && Date.now() - toolsCache.at < TOOLS_TTL_MS) return toolsCache.tools;
  const client = await getBinanceMcp();
  if (!client) return null;
  try {
    const res = await client.listTools();
    const tools = (res.tools ?? []).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as McpTool["inputSchema"] }));
    toolsCache = { tools, at: Date.now() };
    return tools;
  } catch (err) {
    lastError = String(err);
    console.error(`binance mcp listTools: ${lastError}`);
    resetClient();
    return null;
  }
}

/** Unwrap a tool result: structuredContent, else the first text block parsed as JSON, else the text. */
function unwrap(result: unknown): unknown {
  const r = result as { structuredContent?: unknown; content?: Array<{ type: string; text?: string }>; isError?: boolean };
  if (r?.isError) {
    const msg = r.content?.find((c) => c.type === "text")?.text ?? "tool error";
    throw new Error(msg);
  }
  if (r?.structuredContent !== undefined) return r.structuredContent;
  const text = r?.content?.find((c) => c.type === "text")?.text;
  if (text === undefined) return r;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function callBinanceTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const client = await getBinanceMcp();
  if (!client) throw new Error("binance mcp: not authorised");
  const result = await client.callTool({ name, arguments: args });
  return unwrap(result);
}

// ── capability mapping ────────────────────────────────────────────────
// Tool names are discovered, never assumed: the server's catalogue is matched by
// name/description, with BINANCE_MCP_TOOL_MAP as an explicit override.

export type ToolKind = "ticker" | "price" | "klines" | "funding" | "open_interest" | "depth";

const KIND_PATTERNS: Record<ToolKind, RegExp> = {
  ticker: /24h|24hr|ticker.*(stat|change|24)|price.?change|market.?(stat|summary)/i,
  price: /(^|_|\b)(price|ticker)(_|\b|$)/i,
  klines: /kline|candle|ohlc/i,
  funding: /funding/i,
  open_interest: /open.?interest/i,
  depth: /depth|order.?book|orderbook/i,
};

export interface ToolBinding {
  name: string;
  symbolKey: string | null;
  keys: string[];
}

function bindTool(tool: McpTool): ToolBinding {
  const props = tool.inputSchema?.properties ?? {};
  const keys = Object.keys(props);
  const symbolKey = keys.find((k) => /^(symbol|pair|instrument|ticker|market)s?$/i.test(k)) ?? keys.find((k) => props[k]?.type === "string") ?? null;
  return { name: tool.name, symbolKey, keys };
}

export async function pickTool(kind: ToolKind): Promise<ToolBinding | null> {
  const tools = await listBinanceTools();
  if (!tools || tools.length === 0) return null;
  let override: Record<string, string> = {};
  try {
    override = config.binance.mcpToolMap ? (JSON.parse(config.binance.mcpToolMap) as Record<string, string>) : {};
  } catch {
    /* ignore a malformed override */
  }
  const forced = override[kind] ? tools.find((t) => t.name === override[kind]) : undefined;
  if (forced) return bindTool(forced);
  const byName = tools.find((t) => KIND_PATTERNS[kind].test(t.name));
  const byDesc = byName ?? tools.find((t) => KIND_PATTERNS[kind].test(t.description ?? ""));
  return byDesc ? bindTool(byDesc) : null;
}

/** Find a number by trying several key spellings, walking one level of nesting. */
function dig(obj: unknown, names: RegExp, symbol?: string): number | null {
  if (obj == null) return null;
  if (Array.isArray(obj)) {
    const row = symbol ? obj.find((r) => String((r as Record<string, unknown>)?.symbol ?? "").toUpperCase() === symbol.toUpperCase()) ?? obj[0] : obj[0];
    return dig(row, names);
  }
  if (typeof obj !== "object") return null;
  const rec = obj as Record<string, unknown>;
  for (const [k, v] of Object.entries(rec)) {
    if (names.test(k) && (typeof v === "string" || typeof v === "number")) {
      const n = typeof v === "string" ? parseFloat(v) : v;
      if (Number.isFinite(n)) return n;
    }
  }
  for (const key of ["data", "result", "ticker", "item", "payload"]) {
    if (rec[key] !== undefined) {
      const n = dig(rec[key], names, symbol);
      if (n !== null) return n;
    }
  }
  return null;
}

export interface McpSnapshot {
  tool: string;
  price: number | null;
  chg_24h: number | null;
  quote_volume_24h: number | null;
  high_24h: number | null;
  low_24h: number | null;
  funding_rate: number | null;
  funding_tool: string | null;
}

/**
 * Market snapshot for a symbol through the MCP server (public market-data scope).
 * Null when the deployment isn't authorised or the server exposes no matching
 * tool — the caller falls back to Binance's public REST API for the same data.
 */
export async function mcpMarketSnapshot(symbol: string, budget?: BudgetGuard): Promise<McpSnapshot | null> {
  const ticker = (await pickTool("ticker")) ?? (await pickTool("price"));
  if (!ticker) return null;
  budget?.register(`binance-mcp:${ticker.name}`, 0);
  const args: Record<string, unknown> = ticker.symbolKey ? { [ticker.symbolKey]: symbol } : {};
  let raw: unknown;
  try {
    raw = await callBinanceTool(ticker.name, args);
  } catch (err) {
    console.error(`binance mcp ${ticker.name}(${symbol}): ${err}`);
    return null;
  }
  const snap: McpSnapshot = {
    tool: ticker.name,
    price: dig(raw, /^(lastPrice|price|last|close|currentPrice)$/i, symbol),
    chg_24h: dig(raw, /^(priceChangePercent|percentChange24h|change24h|priceChangePct|changePercent)$/i, symbol),
    quote_volume_24h: dig(raw, /^(quoteVolume|quoteVolume24h|volumeUsd|turnover)$/i, symbol),
    high_24h: dig(raw, /^(highPrice|high24h|high)$/i, symbol),
    low_24h: dig(raw, /^(lowPrice|low24h|low)$/i, symbol),
    funding_rate: null,
    funding_tool: null,
  };
  if (snap.price === null) return null; // an unparseable reply is not a read
  const funding = await pickTool("funding");
  if (funding) {
    try {
      budget?.register(`binance-mcp:${funding.name}`, 0);
      const fr = await callBinanceTool(funding.name, funding.symbolKey ? { [funding.symbolKey]: symbol } : {});
      snap.funding_rate = dig(fr, /^(lastFundingRate|fundingRate|rate)$/i, symbol);
      snap.funding_tool = funding.name;
    } catch (err) {
      console.error(`binance mcp ${funding.name}(${symbol}): ${err}`);
    }
  }
  return snap;
}

export async function mcpStatus(): Promise<{ configured: boolean; authorized: boolean; connected: boolean; tools: string[]; error: string | null; client_id: string }> {
  const authorized = hasStoredTokens();
  const tools = authorized ? await listBinanceTools() : null;
  return {
    configured: config.exchange === "binance",
    authorized,
    connected: tools !== null,
    tools: (tools ?? []).map((t) => t.name),
    error: lastError,
    client_id: config.binance.oauthClientMetadataUrl,
  };
}
