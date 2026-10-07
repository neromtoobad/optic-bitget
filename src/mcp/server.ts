import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { runRead, type ForceMode } from "../pipeline/index.js";
import { config } from "../config.js";

// OPTIC AS AN MCP SERVER — the desk as a tool, next to Bitget Agent Hub.
//
// An agent (Claude Code, Claude Desktop, Cursor) adds Optic beside Bitget's own
// read-only tools. Bitget Agent Hub reads the account; Optic stress-tests the
// trader's idea against the perp's own history and every market that prices the
// company, and hands back a cited verdict. It never places anything.
//
//   claude mcp add optic-bitget --transport http <PUBLIC_BASE_URL>/mcp

const BASE = () => config.publicBaseUrl;

/** Trim a verdict for a tool result: agents pay for every token of it. */
function summarize(v: Record<string, unknown>): string {
  const parts = [typeof v.verdict_line === "string" ? v.verdict_line : ""];
  if (typeof v.card_url === "string") parts.push(`\nCard: ${v.card_url}`);
  return parts.filter(Boolean).join("\n");
}

function result(verdict: unknown) {
  const v = verdict as Record<string, unknown>;
  return {
    content: [{ type: "text" as const, text: summarize(v) }, { type: "text" as const, text: JSON.stringify(v) }],
    structuredContent: v,
  };
}

export function buildOpticMcpServer(): McpServer {
  const server = new McpServer(
    { name: "optic-bitget", version: "1.1.0" },
    {
      instructions:
        "Optic is a research desk for Bitget's tokenized US-stock perpetuals (rTokens). Give optic_desk a trade " +
        "idea in plain English; it measures what the perp did in every comparable window of its own history, " +
        "gathers every market that prices the company, has a Bull and a Bear argue citing only that evidence, " +
        "and returns a capped, coverage-limited verdict. Optic reports the map and never issues a trade " +
        "instruction: the words buy, sell, long and short never appear in its own output and must not be added to it.",
    }
  );

  const tools: Array<{ name: string; mode: ForceMode; title: string; description: string; hint: string; max: number }> = [
    {
      name: "optic_desk",
      mode: "desk",
      title: "Research desk — stress-test a trade idea",
      description:
        "Type a trade idea about a Bitget rToken US-stock perpetual in plain English. The desk retrieves every comparable window in the perp's own hourly history (overnight, weekend, earnings or session) and what it did; gathers the perp's basis, funding and open interest, the cash market, technicals, prediction markets, news, SEC filings and the earnings calendar; has a Bull and a Bear argue citing only that evidence; and a judge scores what survived: what's already priced in, the strongest surviving attack, a capped probability and a coverage-capped confidence. It may abstain. It never trades. Every verdict is written to a hash-chained ledger and graded later on the public scoreboard.",
      hint: "The trader's idea in plain English, e.g. 'Long NVDA perp overnight into tomorrow's US open'.",
      max: 500,
    },
    {
      name: "optic_stocks",
      mode: "stocks",
      title: "Tokenized stock check",
      description:
        "One company across markets: Bitget's rToken perpetual (price, basis to index, funding, open interest), the real-world close and analyst consensus from live research, and any prediction market on the company.",
      hint: "A company name or US stock ticker, e.g. 'NVDA'.",
      max: 200,
    },
  ];

  for (const t of tools) {
    server.registerTool(
      t.name,
      { title: t.title, description: t.description, inputSchema: { query: z.string().min(1).max(t.max).describe(t.hint) } },
      async ({ query }) => {
        const { verdict } = await runRead(query, { forceMode: t.mode });
        return result(verdict);
      }
    );
  }

  server.registerTool(
    "optic_status",
    {
      title: "Optic status",
      description: "Which exchange kit this deployment runs on and the HTTP base URL of the same services.",
      inputSchema: {},
    },
    async () => {
      const payload = { exchange: config.exchange, http_base_url: BASE(), scoreboard: `${BASE()}/v1/scoreboard` };
      return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
    }
  );

  return server;
}

/**
 * Handle one Streamable HTTP request. Stateless: a fresh server + transport per
 * request, which is what a horizontally-scaled deployment behind a load balancer
 * can actually honour (no session affinity to lose).
 */
export async function handleMcpRequest(request: Request): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const server = buildOpticMcpServer();
  await server.connect(transport);
  const response = await transport.handleRequest(request);
  response.headers.set("Access-Control-Allow-Origin", "*");
  return response;
}
