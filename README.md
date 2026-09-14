# Optic for Bitget — the research desk

**A research desk for Bitget's tokenized US-stock perpetuals (rTokens). The code computes, the AI argues, and a public scoreboard keeps both honest. It never trades.**

Type a thesis in plain English — *"Long NVDA perp into earnings — funding looks cheap"*. The desk gathers every market that prices the company into an **evidence table**, has a Bull and a Bear argue the thesis **citing only that table**, and a Judge scores what survived: what's already priced in, the single strongest surviving attack, a capped probability, and a confidence that is capped by how much evidence actually came back. It may abstain. Every verdict is written to a hash-chained ledger *before* the trader sees it and graded on the public scoreboard when its horizon elapses.

Built for the **Bitget AI Base Camp Hackathon S2 · Track 3 · AI Trading Desk** — sub-theme *Information Extraction & Signal Generation*. It also covers *Review & Self-Evolution* (the scoreboard) and *Decision Stress Testing* (replay mode) without stretching.

---

## The thesis

Every AI trading desk emits confident prose. At the moment of decision the trader cannot tell a well-grounded call from a fluent hallucination, and more signals make that worse, not better. This desk's premise is that **an AI desk that cannot be cross-examined is dangerous**, so it is built to cross-examine itself — and then to be scored in public on whether it was right.

Three rules run through every line of it:

1. **Computed vs. argued, labelled.** Every number the trader sees — price, basis, funding, open interest, session state, the gap, coverage, Brier — comes from exchange data, the clock, or arithmetic. The model interprets and argues; it never produces a figure. The card and the page label every row `computed` or `argued`.
2. **Citation or it's struck.** Bull, Bear and Judge may cite only rows in the evidence table, by id. A claim with no citation, or citing a row that came back empty or errored, is struck before the Judge reads it. Numbers that don't appear in a cited row are treated as invented.
3. **Missing evidence lowers confidence, never the score.** Coverage is counted. A verdict on 6 of 13 rows cannot be more than 46 % sure — and the desk says so rather than filling the gap with a guess.

## Who it's for

Bitget Pro / VIP retail traders in rToken US-stock **futures**, trading around events — earnings, macro prints, the overnight window — a few times a week with mid-size accounts, who currently juggle X, a news feed and the chart with no way to check whether their idea is already in the price. Not "all traders": a systematic quant doesn't need a debate, and a buy-and-hold investor doesn't trade the perp.

## What it is not

- **Not a trading bot and never an order.** Read-only market data, no Trade permission requested, no Agentic Account. The trader decides; the desk's job ends at the verdict.
- **Not a strategy and not a backtest of one.** There is no alpha claim here. The claim is that the desk's *calls* are calibrated, and the scoreboard is where that claim is tested.
- **Not a black box.** The transcript, the struck citations, the coverage, and the ledger hash are all on the page.

---

## One research task, end to end

```
thesis ──► read ──► evidence table ──► (nothing contested? stop) ──► debate ──► judge ──► verdict ──► ledger ──► scoreboard
           │            │                                              │            │
   deterministic    perp · cash · session · gap · signal skills    Bull/Bear ×2   3 samples, median,
   ticker match     research · prediction — each ok/empty/error    cite-only     P capped 10–90 %,
   (model refines)  coverage counted                               struck ids    confidence ≤ coverage
```

1. **Read.** A deterministic reader matches any word in the thesis against the live rToken universe (Bitget lists ~320 `isRwa` perpetuals) and infers direction and horizon from the wording. When a model key is configured the model refines this (company names, ambiguity); if the thesis can't be judged as written, the desk asks **one** clarifying question and spends nothing else.
2. **Evidence.** Gathered in parallel, each source bounded in time and classified `ok` / `empty` / `error` / `skipped`:

   | id | source | what it carries | computed |
   |---|---|---|---|
   | `perp` | Bitget public REST (USDT-FUTURES) | last, mark, index, **basis**, funding (+ annualised), open interest, spread, 24h volume | ✓ |
   | `cash` | Yahoo chart API | regular-session last, previous close, day range, 52-week range, daily closes | ✓ |
   | `session` | the clock | US cash session open / closed / weekend, minutes to open | ✓ |
   | `gap` | arithmetic | perp vs last cash print, basis, funding, OI, session — the gap itself | ✓ |
   | `crosscheck` | bitget-signal `crypto_derivatives` | a second path to the same perp — two readings of one number | ✓ |
   | `technicals` | bitget-signal `technical_analysis` | RSI, MACD, Bollinger, MA trend, ATR, S/R at 1h | ✓ |
   | `news` `earnings` `macro` `fear_greed` `positioning` | bitget-signal Skills | news, company profile / earnings calendar, rates, F&G, L/S | ✓ (report `error` when their upstreams are down) |
   | `research` | Venice / Claude web search | a sourced equity brief | ✗ argued |
   | `prediction` | Polymarket | any market on the company | ✓ |

3. **Is there anything to argue?** No perp listed → the desk says so. Fewer than three computed rows → **insufficient evidence**, no debate. Perp sitting on its underlying with flat funding and no other market pricing the company → *"nothing here disagrees with the cash market"*, debate skipped **by rule, not by a model**. (The boring case is a required fixture: an agent that only ever raises alarms has demonstrated nothing.)
4. **Debate.** Two rounds, four turns. Each turn is strict JSON — probability, confidence, reasoning, a message to the peer, and the row ids it relies on. Citations are validated in code; struck ids ride along to the Judge.
5. **Judge.** Sampled **three times**, median probability and confidence, majority call, prose from the sample nearest the median. Probability capped to **[0.10, 0.90]**; confidence capped to the **coverage ratio**. May return `insufficient_evidence` — an abstention is a verdict here and is scored like one.
6. **Verdict.** Lint-clean in the desk's own voice (the lint rejects buy / sell / long / short). `holds` · `priced_in` · `contested` · `insufficient_evidence`, plus *what's already priced in* and *the strongest surviving attack*, each citing ids.
7. **Ledger & scoreboard.** The verdict is hash-chained (each row's SHA-256 covers its content and the previous hash — `GET /v1/scoreboard/verify` recomputes the chain from genesis) and graded when the horizon elapses: did the perp move the way the thesis said? Every graded verdict gets a **Brier score** against its own P(holds); the page shows hit rate, mean Brier, a ForecastBench-style **Brier Index** (100 perfect · 50 uninformed · 0 maximally wrong), and reliability buckets.

### Why these particular disciplines

They are not house style; each one is what the forecasting literature and the last year of AI-trading hackathons found separates calibrated systems from fluent ones. Structured (not narrative) probabilities and **capping** at the extremes are the strongest within-winner differentiators among forecasting bots; **ensembling** is used by most of them; frontier models are systematically **over-confident above ~70 %**. Debate improves reasoning *on top of* the inputs but does not audit them — hence the evidence rule. And a coherent debate that ends in consensus is a narrative, not a validated call, until it is checked against what the price did next — hence the scoreboard.

---

## Judge-built scenarios: replay mode

Send `{"query": "...", "at": "2026-08-14T13:00:00Z"}` and the desk rebuilds its own legs **as of that moment** — the perp's last completed hourly bar and the funding rate then in force from Bitget's archives, the cash market's last *known* close from the daily series, the session state for that timestamp — and runs the same debate and judge. Every third-party row is marked `skipped` rather than reconstructed, because none of them can be rebuilt without leaking what came after. Replays are audits of the desk, not forecasts: they are **never ledgered** and never touch the scoreboard. A judge can test a setup whose answer they already know and the desk never tuned for.

## Degraded mode

With no model key at all, the desk still resolves the ticker, gathers the computed legs, renders the gap and the table, and returns **no verdict** — saying exactly that. When `bitget-signal`'s upstreams are down (as they were for news, earnings, macro and sentiment during much of the build week), those rows report `error`, coverage drops, and confidence with it. The desk degrades; it does not go dark.

---

## Running it

```bash
npm install
cp .env.example .env        # set VENICE_API_KEY and/or ANTHROPIC_API_KEY for the debate; the computed legs need no key
npm run dev                 # http://localhost:3000 — the page, the API, the scoreboard
npm test                    # offline suite (35 tests): session boundaries, candle parsing, citation striking, blank-error classification, Brier index, the CEX lenses
npm run smoke:bitget        # live: discover the rToken universe and read NVDA / AAPL / SPY — no model, $0
npm run smoke:desk -- NVDA NVIDIA   # live: the full evidence table with statuses and the gap — no model, $0
npm run desk -- "Long NVDA perp into earnings — funding looks cheap"   # a full read from the CLI
```

| Endpoint | |
|---|---|
| `POST /v1/desk` `{query, at?}` | run the desk (`at` = replay) |
| `GET /v1/scoreboard` | every verdict, graded; summary; calibration; chain status |
| `GET /v1/scoreboard/verify` | recompute the ledger's hash chain from genesis |
| `GET /v1/card/:id` | the verdict card (PNG) |
| `POST /v1/stocks` | Optic's cross-market stock read (the Bitget perp leg replaces the on-chain share) |
| `GET /v1/health` | |

The same desk is an **MCP tool** — `optic_desk` — served over HTTP at `/mcp`, so it runs inside Claude Code, Claude Desktop or Cursor next to Bitget's own server:

```bash
claude mcp add optic-bitget --transport http http://localhost:3000/mcp
```

Bitget Agent Hub in `--read-only` mode is the intended companion: the desk reads, the trader acts.

## What the model does here — and doesn't

*(This is the "Role of the LLM" answer, and it is printed on every read as `llm_role`.)* The model reads the thesis (one small call, refining a deterministic match), argues two sides citing only the table, and judges three times. It never fetches, never computes, never places anything, and never produces a number that isn't in a cited row. Every figure on the card is code. Model choice is a design decision: the Judge runs on the highest-reasoning setting available, because higher-reasoning configurations out-forecast their standard twins in eight of eight paired comparisons in Metaculus's spring 2026 tournament.

## Evidence

- **Reproducible smokes** above — `smoke:bitget` and `smoke:desk` print the live numbers the desk cites, at $0, with no model.
- **The scoreboard is the usage record.** Every read during the competition window is a row with a timestamp, a horizon, the desk's probability, the entry price, and — once resolved — the realised move, the outcome, and the Brier score. `GET /v1/scoreboard/verify` proves none of it was edited.
- **Tests**: `npm test`, 35 offline. The desk's deterministic pieces are tested against fixed dates and fixed payloads, including the exact blank-error shapes the Skill service returns when its upstreams fail.
- **`METRICS.md`** (regenerated by `npm run evidence`) traces every public number to a committed artifact.

## Honest limits

- **Exchange holidays are not modelled.** On a US holiday the session flag reads `open` during regular hours.
- **Grading is directional.** A thesis "held" if the perp moved its way between the read and the horizon. Neutral theses are recorded, not scored. Magnitude and cost are not in the grade — the scoreboard measures the *call*, not a P&L.
- **The transcript is quoted argument.** The Judge's verdict is lint-clean; the analysts' turns may echo words from your thesis ("long"). We chose to show the argument rather than sanitise it.
- **`bitget-signal` is only as live as its upstreams.** The desk names which rows failed and why. It does not proxy them.
- **The replay's cash leg is end-of-day.** Intraday cash prints for a past timestamp are not available without a paid feed; the replay says which close it used.
- **The model path was built against a dead key.** During the build week the desk's own Anthropic credit was exhausted; the debate and judge are implemented and typed, and the degraded path is what has been exercised live. See `METRICS.md` for what has and hasn't been run.

## Against a TradingAgents-style desk

The most-cited multi-agent trading framework — and the most-cloned — puts analysts, a Bull/Bear debate, a trader and a risk team in a LangGraph. This desk shares the debate and deliberately differs everywhere else:

| | TradingAgents-style | this desk |
|---|---|---|
| Debate inputs | whatever the analysts wrote | a typed evidence table with per-row status; citations validated in code |
| When inputs are missing | debate anyway | coverage caps confidence; abstains below a floor |
| When nothing is contested | debate anyway (theatre) | skipped by rule |
| Output | Buy / Hold / Sell | what's priced in, the strongest attack, a capped probability — never an instruction |
| Calibration | none | structured P, capped [0.10, 0.90], 3-sample median |
| After the call | nothing | hash-chained ledger, graded at horizon, public Brier |
| Cost per read | 11+ model calls | 1 read + 4 turns + 3 judge samples, budget-guarded; 0 when nothing is contested |

## Built on

[`optic-cex`](https://github.com/neromtoobad/optic-cex) — the engine, lenses, card renderer, MCP server, budget guard and language lint, with the exchange leg ported to Bitget's public futures API. The Bull/Bear/Judge protocol is lifted from [`delphi-duel`](https://github.com/neromtoobad/delphi-duel) with one inversion: those agents reasoned from priors with no live data; these have the table and may cite nothing else. Bitget Agent Hub and `bitget-signal` provide the perception layer.

MIT. Not financial advice. Nothing here is a recommendation to trade anything.
