# REJECTED

What we tried, or considered, and dropped — with the number or fact that killed it. Kept because a graveyard is more useful to the next builder than a feature list.

| Idea | Why it's out | Evidence |
|---|---|---|
| Aim the desk at "Decision Stress Testing" as its named sub-theme | Bitget defines that sub-theme as *historical scenario retrieval*, not adversarial debate; a debate engine would have been scored against the wrong question | S2 handbook, Track 3 sub-theme table |
| The overnight-gap indicator as the product (0–100 "how far has the perp drifted" score) | An indicator, not a workbench; every entrant will ship "AI reads news, emits a score"; and it leaned on research adjacent to a prior Playbook entry (campaign rules treat similar submissions as DQ) | prior `getagent-playbooks` README; S2 rule "no simple reuse" |
| Bull/Bear/Judge as the novelty claim | Already shipped in S1 Track 3 (GapGuard's five-role "Quorum" desk with a hash-chained lesson log). The debate is a known-good structure the judges like — not what makes this undeniable | GapGuard README |
| Hardcoding the rToken ticker list | Bitget's contract endpoint flags `isRwa` on 320 perpetuals (not the ~20 stocks we assumed), including pre-IPO names; discovery beats a list that is stale on day one | `artifacts/rwa-universe.json` |
| Yahoo `quoteSummary` / `v7/quote` for earnings dates and market state | Both return HTTP 401 without a browser crumb; only the `v8/chart` endpoint is open | probe, 2026-09-14 |
| `chartPreviousClose` as yesterday's close | It is the close before the *range*, not the prior session (230.36 vs the real 218.29 for NVDA); previous close must come from the daily series | probe, 2026-09-14 |
| `bitget-signal` as a load-bearing source | Its Bitget-backed tools answer; every tool that reaches an external upstream (`global_assets`, `tradfi_news`, `macro_indicators`, `sentiment_index`, `news_feed latest`, `crypto_price`) returned blank errors across three probes. Additive with coverage reporting, never required | `artifacts/bitget-signal-status.json`; evidence rows |
| Letting the model produce any number | Winners across finance hackathons draw the same line — the model interprets, code computes — and judges dinged the entry that blurred it | research notes (Kepler, Project Europe, Budgie) |
| Narrative confidence ("I'm fairly sure") | Narrative prompts wreck calibration; structured probabilities, capped, ensembled, are what winning forecasting bots do | Metaculus 11-analysis review; arXiv 2507.04562 |
| Linting the analysts' transcript | The lint bans buy/sell/long/short; the trader's own thesis says "long", and sanitising quoted argument would either mangle it or hide it. The desk's verdict is lint-clean; the transcript is shown as argument | design decision |
| Grading replays on the scoreboard | A replay is an audit of the desk on a known past, not a forecast; scoring it would inflate the record with hindsight | design decision |
| Node 24 locally with `better-sqlite3@11` | Aborts at teardown (`RemoveEnvironmentCleanupHook … env != nullptr`) and hides script output under 80 lines of native stack. Fixed by `better-sqlite3@13`; production pins Node 20 | runtime notes |
