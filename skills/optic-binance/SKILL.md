---
name: optic-binance
description: |
  Cross-venue market read for any Binance-listed coin, token, or story: the Binance exchange
  (spot + perps via the Binance MCP Server), Binance Web3 onchain data, Binance Wallet prediction
  markets and the social-hype board, compared in one call, with a 0-100 gap score and a shareable
  card. Use when the user asks "what's the read on X", "where do the markets disagree on X",
  "is X early or late", "is this token safe", "what's smart money buying", "today's picks",
  "where's the edge", or wants a Binance Wallet prediction position turned into baw commands.
  Data and analysis only — never a trade instruction.
metadata:
  author: neromtoobad
  version: "1.0"
license: MIT
---

# Optic for Binance

Two ways in — as an MCP server, or as plain HTTP.

**MCP (preferred).** Optic runs alongside the Binance MCP Server in the same session:

```bash
claude mcp add binance-mcp-server --transport http https://agent.binance.com/mcp/agentic
claude mcp add optic --transport http https://optic-binance-production.up.railway.app/mcp
```

Then call `optic_read`, `optic_daily`, `optic_edge`, `optic_rug`, `optic_timing`, `optic_smart_money`, `optic_pulse`, `optic_stocks`, `optic_ticket`, `optic_scan`, `optic_status`.

**When both servers are connected, fetch the exchange leg first.** Call your Binance market-data tools for the symbol (24h ticker, and funding / open interest / long-short ratio if available), then pass those results verbatim into `optic_read` as `binance_market_data`. Optic reads price, 24h change, volume, funding, open interest and account skew out of them and uses that as the exchange side of the comparison. Binance's MCP Server only accepts its own approved clients, so this is the only way the exchange leg genuinely comes through an MCP session — yours.

**HTTP.** Base URL: `https://optic-binance-production.up.railway.app` (override with `OPTIC_BASE_URL`).

## Commands

| User intent | Request |
|---|---|
| Full read on a coin / token / story | `POST /v1/read` `{"query":"BTC"}` — also accepts a contract address or a sentence |
| What's heating up | `POST /v1/read` `{"query":"what's heating up"}` |
| Today's picks | `POST /v1/daily` (empty body) |
| Mispriced prediction markets | `POST /v1/edge` (empty body) |
| Token safety | `POST /v1/rug` `{"query":"<address or ticker>"}` |
| Smart money accumulation | `POST /v1/smart-money` (empty body) |
| Early or late | `POST /v1/timing` `{"query":"<token>"}` |
| Tokenized stock read | `POST /v1/stocks` `{"query":"NVDA"}` |
| Up/Down windows vs the tape | `POST /v1/pulse` (empty body) |
| Turn a decision into Agentic Wallet commands | `POST /v1/ticket` `{"query":"Fed decision in September no change","side":"yes","usdt":25}` |
| Is Optic connected to the Binance MCP Server | `GET /v1/binance/status` |

```bash
curl -s -X POST "$OPTIC_BASE_URL/v1/read" -H 'content-type: application/json' -d '{"query":"BTC"}'
```

## How to present the result

- Lead with `verdict_line`, then `divergence.score` (0-100, how far apart the markets are) and `divergence.reasoning`.
- `venues.binance` is the exchange read (`source` says `binance-mcp` or `binance-api`); `venues.meme` is onchain; `venues.prediction.markets` are Binance Wallet prediction markets; `attention` is the social-hype board.
- A `null` venue means that market is not pricing the story — say so; it is signal, not an error.
- Show `card_url` as the shareable image.
- Never turn the read into an instruction. The words buy / sell / long / short do not appear in Optic's output and must not be added.

## Acting on it (the caller's rails, not Optic's)

- Spot / perps: the user's own **Binance MCP Server** connection (`claude mcp add binance-mcp-server --transport http https://agent.binance.com/mcp/agentic`) — every order is confirmed by the user first.
- Prediction markets: the `/v1/ticket` response carries `ticket.plugin_rail.quote_command` and `place_command` for the user's **binance-agentic-wallet** skill (`baw prediction trade quote` → `place-order`). Run step 1, show the quote, ask for confirmation, then run step 2.
