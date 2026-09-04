# Optic for CEX

**One agent that reads every CEX market at once and tells you where they stop agreeing.**

Built on **CEX Agent OS** for the Agent OS Mini Hackathon (Track A · Data Analysis).

The exchange prices leverage. The chain prices holders. The prediction market prices the outcome. The crowd prices the story. A single-domain agent reads one of those and calls it truth. Optic reads them together and reports the gap — and the gap is the signal.

**Live:** https://optic-cex-production.up.railway.app · MCP at `/mcp` · HTTP at `/v1/*`

---

## The workflow

CEX's MCP Server accepts connections only from its allowlisted agent clients — Claude Code, Claude Desktop, Codex CLI, ChatGPT, VS Code, Grok. A third-party service authorising as itself is refused at the consent screen with *"The AI Agent you are using is not currently supported."* There is no published registration path for a custom client, and Optic does not present itself as one it isn't.

So the CEX session stays where CEX intends it to live — in your own agent — and **Optic joins that same session as a second MCP server**:

```
Claude Code ─┬─ cex-mcp-server ──> CEX   (market data · execution, your authorised session)
             └─ optic ──────────────> the cross-venue read + the gap
```

```bash
claude mcp add cex-mcp-server --transport http https://agent.cex.com/mcp/agentic
claude mcp add optic --transport http https://optic-cex-production.up.railway.app/mcp
```

Then it is one conversation. Your agent pulls the exchange leg with its **own** CEX tools, passes those results into `optic_read` as `cex_market_data`, and Optic reports that leg as `source: "cex-mcp"` — because that is genuinely where the numbers came from. Pass nothing and Optic reads the same public figures from CEX's data API and says `cex-api` instead. A payload it cannot actually read is refused rather than half-read. Nothing is ever invented.

---

## What it reads, and through which CEX kit

| Venue | CEX kit | What Optic pulls |
|---|---|---|
| **Exchange** (spot + perps) | **CEX MCP Server**, with the public CEX API as the fallback door | spot price, 24h change, volume · funding, open interest and its 24h change, account skew, taker flow, perp basis |
| **Onchain** | CEX Web3 token APIs (the `query-token-info` endpoints) | price, liquidity, holders · dev / sniper / bundler / insider / smart-money / KOL / CEX-user cohorts · volume acceleration |
| **Prediction markets** | CEX Wallet prediction markets (Predict.fun outcome tokens on BNB Chain) | priced probability, volume, liquidity, end time — ranked by relevance before size |
| **Attention** | CEX Web3 social-hype board + topic radar | relative hotness, trend, sentiment label, the board's AI summary, KOL count · hot narratives for story queries |
| **Safety** | CEX token security audit (`query-token-audit`) | contract-mechanism hits, transfer taxes, holder concentration → 0–100 risk score |
| **Smart money** | CEX Web3 smart-money signals + net-inflow rank | who is accumulating what, wallet counts, inflow |
| **Stocks** | CEX-listed Ondo tokenized stocks | on-chain per-share price vs the real close vs analyst consensus |

Research and synthesis run on the LLM layer. A lens with no data returns `null` — "no prediction market is pricing this" is itself a finding.

---

## The ten services

Each is one MCP tool and one HTTP endpoint. No login, no dashboard, no API key.

| Tool | Endpoint | Returns |
|---|---|---|
| `optic_read` | `POST /v1/read` | full cross-venue read → gap score, reasoning, card |
| `optic_scan` | `POST /v1/read` `{"query":"what's heating up"}` | hype accelerators, hot narratives, fresh launches, smart-money inflow |
| `optic_daily` | `POST /v1/daily` | today's decisive, research-backed calls |
| `optic_edge` | `POST /v1/edge` | where a market's price looks soft or rich against research |
| `optic_rug` | `POST /v1/rug` | token safety score 0–100 + red flags |
| `optic_timing` | `POST /v1/timing` | early or late: lifecycle stage for a token |
| `optic_smart_money` | `POST /v1/smart-money` | tokens sharp wallets are accumulating |
| `optic_stocks` | `POST /v1/stocks` | tokenized share vs real close vs consensus |
| `optic_pulse` | `POST /v1/pulse` | BTC · ETH · SOL Up/Down windows vs the spot tape |
| `optic_ticket` | `POST /v1/ticket` | a decided position → the exact `baw prediction trade` commands for your own Agentic Wallet |

Free: `GET /v1/health` · `GET /v1/cex/status` · `GET /v1/card/:id`

```bash
curl -s -X POST https://optic-cex-production.up.railway.app/v1/read \
  -H 'content-type: application/json' -d '{"query":"BTC"}'
```

---

## Acting on a read

Optic constructs, the caller signs. It holds no trade or transfer scope anywhere and never touches a key.

- **Spot / perps** — your own CEX MCP connection, in your Agentic sub-account, confirm-before-execute.
- **Prediction markets** — `optic_ticket` returns the two `baw prediction trade` commands (`quote`, then `place-order`) for your own **CEX Agentic Wallet**. Run the quote, show it to the user, place only after they confirm. The wallet's own confirmation gate and daily limit still apply.

---

## Not financial advice, and structurally so

Optic reports the map, never a trade instruction. The words *buy*, *sell*, *long* and *short* are lint-gated in code before any response leaves the service ([src/lint.ts](src/lint.ts)); a model output containing one is rejected and regenerated. The language is observational: priced-in, lagging, crowded, asleep, unhedged. Confidence means signal strength — volume, conviction, corroboration — and never a claimed win rate.

---

## Run it

```bash
npm install
cp .env.example .env      # add VENICE_API_KEY and/or ANTHROPIC_API_KEY
EXCHANGE=cex npm run dev

npm run cex -- BTC              # the exchange venue alone
npm run cex:web3 -- search pepe  # any CEX Web3 endpoint
npm run pulse                        # Up/Down windows vs the tape
npm test                             # unit tests
./scripts/smoke-cex.sh http://localhost:3000
```

`EXCHANGE=cex` selects the CEX kits. The engine is venue-agnostic by design — lenses are data adapters behind one interface — so each one branches at its entry point and the rest of the pipeline never knows which venue it is reading.

---

## Stack

TypeScript · Node 20 · Hono · better-sqlite3 · Railway
MCP: `@modelcontextprotocol/sdk` — Optic is both an MCP **server** (`/mcp`, Streamable HTTP, stateless) and, where permitted, an MCP client
Data: CEX MCP Server · CEX API · CEX Web3 (token, audit, social hype, topic radar, smart money, Ondo RWA) · CEX Wallet prediction markets
Cards: satori + resvg

## Payments

CEX's x402 facilitator, **B402**, is the matching rail (`/papi/v2/b402/*`, BSC USDT/USDC/U/USD1, gas sponsored). It requires merchant onboarding — clientId, RSA key registration, IP allow-list — so this deployment runs with `PAYMENTS_ENFORCED=false` and every endpoint is open. The x402 middleware and accept-shape are already in place for when those credentials exist.
