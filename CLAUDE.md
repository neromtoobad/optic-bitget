# CLAUDE.md — Optic for Bitget

## What this is
A research desk for Bitget's tokenized US-stock perpetuals (rTokens). You type a thesis; the desk measures what the perp actually did in every comparable window of its own history, gathers every market that prices the company, argues it, and keeps public score. **It never trades.**

Built for the Bitget AI Base Camp Hackathon S2 · Track 3 · AI Trading Desk — named sub-theme **Decision Stress Testing** (*input trade idea → retrieve historical distribution; preset stress tests*).

## The shape that must not be lost
The Optic engine is one thing — `narrative → attention → per-venue read → divergence → verdict + card` — and the lenses are data adapters behind one interface. Every lens may return `null`; absence is reported honestly and is itself signal.

The desk adds one loop on top:

```
thesis → read → analogs (the perp's own archive) → evidence table → contested?
       → debate (cite-only) → judge (ensembled, capped) → ledger → scoreboard
```

Three rules run through all of it:
1. **Computed vs. argued, labelled.** Every number comes from exchange data, the archive, the clock, or arithmetic. The model interprets and argues; it never produces a figure.
2. **Citation or it's struck.** Bull, Bear and Judge may cite only evidence-row ids. Uncited claims, or claims citing a non-ok row, are struck in code before the Judge reads them.
3. **Missing evidence lowers confidence, never the score.** Coverage is counted and caps confidence. The desk may abstain, and abstentions are graded.

## The centrepiece
`src/desk/analogs.ts` — for any thesis, find the comparable windows in the perp's hourly archive (overnight / weekend / earnings / session) and measure what the perp did: hit rate, median, p10/p90, worst against, the cash gap each window contained, the perp's residual at the cash open, and the funding cost of holding through. The Laplace-smoothed hit rate is a **base-rate forecast**, ledgered and graded beside the judge — so the scoreboard's standing question is *does the debate beat history?*

`src/desk/archive.ts` pages each watchlist perp back to its listing date into `HISTORY_DIR` (a mounted volume in production) at boot, and extends it daily.

## Layout
- `src/lib/bitget/` — `rest.ts` (public USDT-FUTURES market data + contract discovery), `session.ts` (US cash session from the clock), `signal.ts` (bitget-signal's public MCP service)
- `src/lib/` — `yahoo.ts` (cash leg), `news.ts` (Yahoo + Google RSS), `events.ts` (SEC EDGAR + Nasdaq calendar), `polymarket-search.ts`
- `src/desk/` — `analogs.ts`, `evidence.ts`, `debate.ts`, `judge.ts`, `index.ts` (runner), `ledger.ts`, `archive.ts`, `series.ts`, `watchlist.ts`, `types.ts`
- `src/lenses/`, `src/engine/`, `src/card/`, `src/mcp/` — the inherited Optic engine. Lenses branch on `config.exchange`; never mix kits inside one lens.
- `site-bitget/index.html` — the workbench (light theme, sidebar shell, composer hero)

## Non-negotiables
- Report the map, **never** a trade instruction. No buy/sell/long/short in the desk's own voice — lint-gated in `src/lint.ts` before any response leaves. The analysts' transcript is quoted argument and is exempt by design.
- Never fabricate data. A source with nothing returns `null` and its row says `empty` or `error`.
- Read-only always: no Trade permission, no Agentic Account, no key touched.
- Confidence is signal strength, never a claimed win rate.
- The ledger's hashed field set is **versioned** (`hash_version`). Adding a column must never invalidate rows written before it — verify each row under the scheme its own version names.
- Replays (`{at}`) are audits, not forecasts: they are never ledgered.

## Environment quirks
- **Node 24 + better-sqlite3 v11 aborts at teardown.** Pinned to v13. Production runs Node 22 with python3, make and g++ in the image (Dockerfile), because better-sqlite3 13 has no matching prebuild there.
- **One process per SQLite file.** Tests use `./data/test.db`, smokes `./data/smoke.db`, the server `./data/optic.db`; the suite runs `--test-concurrency=1`.
- Keep live-network smokes in `scripts/`, never `test/` — the glob sweeps `test/*.test.ts` into `npm test`.
- macOS has no `timeout`; use `perl -e 'alarm N; exec @ARGV' -- cmd`.
- `bitget-signal`'s Bitget-backed tools answer; its upstream-dependent ones (news, macro, sentiment, global_assets) return blank errors. Additive only — never load-bearing.
- Yahoo's `v8/chart` is open; `v7/quote` and `quoteSummary` return 401 without a crumb. `chartPreviousClose` is the close before the *range*, not yesterday — derive previous close from the daily series.

## Verify
`npm test` (25 offline) · `npx tsc --noEmit` · `npm run smoke:bitget` · `npm run smoke:desk -- NVDA NVIDIA` · `npm run evidence` (regenerates `artifacts/` + `METRICS.md`)
