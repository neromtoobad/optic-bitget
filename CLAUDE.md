# CLAUDE.md — Optic for CEX

## What this is
Optic reads every market that prices the same story — the CEX exchange (spot + perps), CEX Web3 onchain data, CEX Wallet prediction markets, and the CEX Web3 social-hype board — and reports where they stop agreeing. The gap is the product.

Built on CEX Agent OS for the Agent OS Mini Hackathon (Track A, Data Analysis).

## Core engine (never lose this shape)
ONE engine, applied through venue lenses:
`narrative → attention → per-venue read → divergence → verdict + card`

Lenses are data adapters behind one interface, not features. Any lens may return `null`; absence is reported honestly and is itself signal.

## Architecture note that matters most
CEX's MCP Server is allowlisted to approved agent clients (Claude Code, Claude Desktop, Codex, ChatGPT, VS Code, Grok). Optic authorising as itself is refused: "The AI Agent you are using is not currently supported. (3346001)". **Do not spoof an approved client_id.**

Instead: Optic is itself an MCP server (`/mcp`, `src/mcp/server.ts`), the caller's agent holds the CEX session, and passes its CEX tool output into `optic_read` as `cex_market_data` → parsed by `src/lib/cex/inject.ts` → reported as `source: "cex-mcp"`. Without it, the same public numbers come from CEX's data API as `source: "cex-api"`. The MCP client code (`src/lib/cex/mcp.ts`) stays for the day registration opens.

## Layout
- `src/lib/cex/` — `rest.ts` (public market data), `web3.ts` (CEX Web3 endpoints), `mcp.ts` (MCP client), `inject.ts` (parse the caller's MCP output)
- `src/lenses/cex/` — the venue adapters
- `src/mcp/server.ts` — Optic as an MCP server, 11 tools
- `src/{scan,daily,edge}/cex.ts`, `src/pulse-cex.ts`, `src/ticket/cex.ts` — the desks
- Each lens branches on `config.exchange` at the top of its entry function. Keep it that way; never mix kits inside one lens.

## Non-negotiables
- Report the map, NEVER a trade instruction. No buy/sell/long/short. Language is observational: priced-in, lagging, diverging, crowded, asleep. Lint-gated in `src/lint.ts` before any response leaves.
- Never fabricate venue data. A lens with nothing returns `null`.
- Confidence means signal strength, never a claimed win rate. No accuracy or earnings claims anywhere.
- The caller signs. Optic holds no trade or transfer scope and never touches a key.

## Environment quirks
- Railway's US regions get HTTP 451 from `api.cex.com` and `fapi.cex.com`. Spot data uses `data-api.cex.vision`; futures data is unavailable server-side from a US region, which is one more reason the caller's own MCP session is the better path for perps.
- CEX Wallet prediction markets have a public web API (`…/wallet-direct/prediction/web/market/{search,list,detail-by-slug}`, POST JSON). The `/agent/*` variants need a wallet login — don't use those server-side.
- B402 (CEX x402) needs merchant onboarding, so payments run off.

## Verify
`npm test` · `npx tsc --noEmit` · `./scripts/smoke-cex.sh <base-url>`
