import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { runRead, type ForceMode } from "../pipeline/index.js";
import { exchangeFromMcpPayload } from "../lib/cex/inject.js";
import { config } from "../config.js";

// OPTIC AS AN MCP SERVER — the other half of the Agent OS workflow.
//
// CEX's MCP Server accepts connections only from its allowlist of approved
// agent clients, which is the right call and one Optic should not try to route
// around. So the connection stays where it belongs — in the user's own agent —
// and Optic joins the same session as a second MCP server:
//
//   Claude Code ── cex-mcp-server ──> CEX (market data, execution)
//               └─ optic ──────────────> the cross-venue read + the gap
//
// The agent fetches the exchange leg with its own authorised CEX tools and
// passes it into `optic_read` as `cex_market_data`. Optic reports that leg
// as `source: "cex-mcp"` because that is genuinely where it came from, and
// falls back to CEX's public data API when the caller passes nothing.

const BASE = () => config.publicBaseUrl;

/** Trim a verdict for a tool result: agents pay for every token of it. */
function summarize(v: Record<string, unknown>): string {
  const line = typeof v.verdict_line === "string" ? v.verdict_line : "";
  const div = v.divergence as { score?: number; direction?: string; reasoning?: string[] } | undefined;
  const parts = [line];
  if (div?.score !== undefined) parts.push(`\nGap ${div.score}/100 (${div.direction ?? "—"})`);
  for (const r of div?.reasoning ?? []) parts.push(`· ${r}`);
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

const QUERY = z.string().min(1).max(200);

const CEX_INJECT = z
  .unknown()
  .optional()
  .describe(
    "Optional. The raw output of your OWN CEX MCP Server market-data tools for this symbol " +
      "(24h ticker, and if you have them funding rate / open interest / long-short ratio). Paste the tool " +
      "results verbatim — object, array of objects, or JSON string. Optic reads price, 24h change, volume, " +
      "funding, open interest and account skew out of it and uses it as the exchange leg of the comparison, " +
      "marked source=cex-mcp. Omit it and Optic reads the same public numbers from CEX's data API."
  );

export function buildOpticMcpServer(): McpServer {
  const server = new McpServer(
    { name: "optic", version: "1.0.0" },
    {
      instructions:
        "Optic reads every market that prices the same story — the CEX exchange, onchain, prediction " +
        "markets and social attention — and reports where they stop agreeing. When you also have the CEX " +
        "MCP Server connected, fetch the exchange leg with it first and pass those tool results into " +
        "optic_read as cex_market_data; that makes the exchange side of the comparison come through your " +
        "own authorised CEX session. Optic reports the map and never issues a trade instruction: the " +
        "words buy, sell, long and short never appear in its output and must not be added to it.",
    }
  );

  server.registerTool(
    "optic_read",
    {
      title: "Cross-venue market read",
      description:
        "The full read on any coin, token, contract address, event or story: the CEX exchange (spot + " +
        "perps positioning), onchain data, CEX Wallet prediction markets and the social-hype board, " +
        "compared in one call. Returns a 0-100 gap score for how far apart those markets are, the reasoning " +
        "with the numbers behind it, and a shareable card. Data and analysis only.",
      inputSchema: { query: QUERY.describe("A ticker (BTC), a contract address, or a story in plain words."), cex_market_data: CEX_INJECT },
    },
    async ({ query, cex_market_data }) => {
      const injected = cex_market_data === undefined ? null : exchangeFromMcpPayload(cex_market_data);
      const { verdict } = await runRead(query, injected ? { injectedCEX: injected } : {});
      return result(verdict);
    }
  );

  const modes: Array<{ name: string; mode?: ForceMode; query?: string; title: string; description: string; needsQuery: boolean }> = [
    {
      name: "optic_scan",
      query: "what's heating up",
      title: "Market scan",
      description: "Discovery over the whole market: which tokens' social hype is accelerating before the crowd, which AI-detected narratives are pulling inflow, what just launched with real activity, and where smart-money inflow concentrates.",
      needsQuery: false,
    },
    {
      name: "optic_daily",
      mode: "daily",
      title: "Today's picks",
      description: "Today's strongest signals across prediction markets and onchain momentum, as decisive research-backed calls with the evidence. Confidence is signal strength, never a claimed win rate.",
      needsQuery: false,
    },
    {
      name: "optic_edge",
      mode: "edge",
      title: "Mispriced markets",
      description: "Where a prediction market's priced probability looks soft or rich against live web research. Conservative by design — the market is usually right, and an honest 'nothing today' is a valid answer.",
      needsQuery: false,
    },
    {
      name: "optic_smart_money",
      mode: "smartmoney",
      title: "Smart money watch",
      description: "Tokens that CEX-tracked smart-money wallets are accumulating right now, by wallet count and inflow. Factual flow, never a trade instruction.",
      needsQuery: false,
    },
    {
      name: "optic_pulse",
      title: "Up/Down pulse",
      description: "BTC, ETH and SOL short-horizon Up/Down windows on CEX Wallet prediction markets, set against the live CEX spot tape — where the market leans versus where price actually is.",
      needsQuery: false,
    },
    {
      name: "optic_rug",
      mode: "rug",
      title: "Token safety check",
      description: "Token security audit plus holder composition into a 0-100 risk score with the concrete red flags: contract mechanisms, transfer taxes, dev/sniper/bundler/insider concentration. Risk disclosure, never advice.",
      needsQuery: true,
    },
    {
      name: "optic_timing",
      mode: "timing",
      title: "Early or late",
      description: "Lifecycle stage for a token — igniting, building, peaking, cooling or quiet — from its age, its social-hype trajectory and its onchain activity acceleration.",
      needsQuery: true,
    },
    {
      name: "optic_stocks",
      mode: "stocks",
      title: "Tokenized stock check",
      description: "One company across markets: the exchange-listed tokenized share price on-chain, the real-world close and analyst consensus from live research, and any prediction market on the company.",
      needsQuery: true,
    },
  ];

  for (const m of modes) {
    server.registerTool(
      m.name,
      {
        title: m.title,
        description: m.description,
        inputSchema: m.needsQuery ? { query: QUERY.describe("A token ticker, contract address, or company/ticker for stocks.") } : {},
      },
      async (args: { query?: string }) => {
        if (m.name === "optic_pulse") {
          const { runPulse } = await import("../pulse.js");
          return result(await runPulse());
        }
        const query = m.needsQuery ? (args.query ?? "") : (m.query ?? m.mode ?? "read");
        const { verdict } = await runRead(query, m.mode ? { forceMode: m.mode } : {});
        return result(verdict);
      }
    );
  }

  server.registerTool(
    "optic_ticket",
    {
      title: "Order ticket",
      description:
        "Turns a decision the CALLER has already made into a ready-to-place order on a CEX Wallet " +
        "prediction market: resolves the live market, reads the priced outcome, sizes the position and returns " +
        "the exact `baw prediction trade quote` and `place-order` commands for the caller's own CEX " +
        "Agentic Wallet. Optic never chooses the side and never signs — run the quote, show it to the user, and " +
        "only place after they confirm.",
      inputSchema: {
        query: QUERY.describe("The market in plain words, e.g. 'Fed decision in September no change'."),
        side: z.enum(["yes", "no"]).describe("Which side the caller has decided on. Optic never picks this."),
        usdt: z.number().positive().max(100000).describe("Size in USDT."),
        limit: z.number().gt(0).lt(1).optional().describe("Optional limit price between 0 and 1; omit for a market order."),
      },
    },
    async ({ query, side, usdt, limit }) => {
      const { planTicket } = await import("../ticket/index.js");
      const v = await planTicket({ query, side, usdt, limit });
      return result(v as unknown as Record<string, unknown>);
    }
  );

  server.registerTool(
    "optic_status",
    {
      title: "Optic status",
      description: "Which exchange kit this Optic deployment runs on, whether it holds its own CEX MCP session, and the HTTP base URL of the same services.",
      inputSchema: {},
    },
    async () => {
      const { mcpStatus } = await import("../lib/cex/mcp.js");
      const s = config.exchange === "cex" ? await mcpStatus() : null;
      const payload = {
        exchange: config.exchange,
        http_base_url: BASE(),
        own_mcp_session: s ? { authorized: s.authorized, tools: s.tools.length } : null,
        note:
          "CEX's MCP Server only accepts its allowlisted agent clients, so Optic does not hold a session of " +
          "its own by default. Pass your CEX MCP tool output into optic_read as cex_market_data and the " +
          "exchange leg comes through YOUR session.",
      };
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
