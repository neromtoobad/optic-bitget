import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { cacheKey, cacheGet, cacheSet } from "../../db.js";
import type { BudgetGuard } from "../../pipeline/budget.js";

// bitget-signal — Optic is an MCP *client* of Bitget's public market-data
// service: the same server the five bitget-signal Skills (macro-analyst,
// market-intel, news-briefing, sentiment-analyst, technical-analysis) point
// Claude Code at. Streamable HTTP, no account, no key. The Skills are prompts;
// the tools live here. This is the desk's perception layer — cash-market
// quotes, the earnings calendar, news, rates and macro prints, derivatives
// positioning. Every value the debate cites is fetched here as data, never
// recalled from a model.
//
// The edge in front of the server refuses some default User-Agents (python's
// is rejected, curl's accepted), so the transport pins an explicit one.

const SERVER_URL = process.env.BITGET_SIGNAL_MCP_URL ?? "https://datahub.noxiaohao.com/mcp";
const USER_AGENT = process.env.BITGET_SIGNAL_UA ?? "optic-bitget/1.0 (+https://github.com/neromtoobad)";
const TOOLS_TTL_MS = 10 * 60_000;
// Tool results are cached briefly — quotes and news move, but a debate that
// fans out three agents over the same evidence must not fetch it three times.
const CALL_TTL_S = 120;
const CALL_TIMEOUT_MS = 90_000;
const CONNECT_TIMEOUT_MS = 10_000;

let clientPromise: Promise<Client | null> | null = null;
let lastError: string | null = null;
let toolsCache: { tools: McpTool[]; at: number } | null = null;

function resetClient(): void {
  clientPromise?.then((c) => c?.close().catch(() => undefined));
  clientPromise = null;
  toolsCache = null;
}

/** A connected client, or null when the public server is unreachable (never throws). */
export async function getSignalMcp(): Promise<Client | null> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const transport = new StreamableHTTPClientTransport(new URL(SERVER_URL), {
        requestInit: { headers: { "User-Agent": USER_AGENT } },
      });
      const client = new Client({ name: "optic-bitget", version: "1.0.0" });
      transport.onclose = () => {
        clientPromise = null;
        toolsCache = null;
      };
      try {
        // The SDK's connect has no timeout of its own; a wedged initialize must
        // not hold the desk (or a test process) open forever.
        await Promise.race([
          client.connect(transport),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`connect timed out after ${CONNECT_TIMEOUT_MS}ms`)), CONNECT_TIMEOUT_MS).unref()),
        ]);
        lastError = null;
        return client;
      } catch (err) {
        transport.close().catch(() => undefined);
        lastError = String(err);
        console.error(`bitget-signal connect: ${lastError}`);
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

export async function listSignalTools(): Promise<McpTool[] | null> {
  if (toolsCache && Date.now() - toolsCache.at < TOOLS_TTL_MS) return toolsCache.tools;
  const client = await getSignalMcp();
  if (!client) return null;
  try {
    const res = await client.listTools();
    const tools = (res.tools ?? []).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as McpTool["inputSchema"] }));
    toolsCache = { tools, at: Date.now() };
    return tools;
  } catch (err) {
    lastError = String(err);
    console.error(`bitget-signal listTools: ${lastError}`);
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

/**
 * Cache-first, budget-registered tool call. Returns the unwrapped payload, or
 * null on any failure — the perception layer is additive, a missing source is
 * reported as missing (coverage), never thrown through the pipeline.
 */
export async function callSignalTool(name: string, args: Record<string, unknown>, opts: { budget?: BudgetGuard; ttl?: number } = {}): Promise<unknown | null> {
  const key = cacheKey(`bitget-signal:${name}`, args);
  const hit = cacheGet<unknown | null>(key);
  if (hit !== undefined) return hit;
  opts.budget?.register(`bitget-signal:${name}`, 0); // public data, no per-call cost
  const client = await getSignalMcp();
  if (!client) return null;
  try {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS });
    const data = unwrap(result);
    cacheSet(key, data, opts.ttl ?? CALL_TTL_S);
    return data;
  } catch (err) {
    lastError = String(err);
    console.error(`bitget-signal ${name}(${JSON.stringify(args)}): ${lastError}`);
    return null;
  }
}

/** Close the session — scripts must call this, or the SSE stream keeps the process alive. */
export async function closeSignalMcp(): Promise<void> {
  resetClient();
}

export async function signalStatus(): Promise<{ url: string; connected: boolean; tools: string[]; error: string | null }> {
  const tools = await listSignalTools();
  return { url: SERVER_URL, connected: tools !== null, tools: (tools ?? []).map((t) => t.name), error: lastError };
}
