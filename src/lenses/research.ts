import Anthropic from "@anthropic-ai/sdk";
import type { Resolved } from "../types.js";
import { config } from "../config.js";
import { cacheKey, cacheGet, cacheSet } from "../db.js";
import { BudgetGuard } from "../pipeline/budget.js";
import { isCliEntry } from "../fixtures.js";

// RESEARCH lens — the value-add layer. For an event/sports/macro narrative, pull
// the real-world context the raw market odds don't tell you: recent form,
// injuries, roster news, weather, catalysts. Uses Venice web search (cheap,
// reliable, reuses the existing key). Cached 10m. This is what makes a 0.5 USDT
// read worth more than glancing at Polymarket yourself.

export interface ResearchBrief {
  brief: string;
  sources: string[];
}

// Fast Venice model with web search. Conservative token pricing for the budget
// guard; the real per-token cost is well under this.
const MODEL = "zai-org-glm-4.7-flash";
const INPUT_USD_PER_TOKEN = 1 / 1_000_000;
const OUTPUT_USD_PER_TOKEN = 3 / 1_000_000;

function prompt(subject: string): string {
  return `You are a research analyst preparing a briefing for a prediction/betting read on: "${subject}".

Search the web for the most recent, decision-relevant facts. Prioritise, as applicable:
- current form / recent results
- injuries, suspensions, roster/lineup news
- venue, weather, schedule/fixture context
- any fresh catalyst or news in the last few days

Write a tight briefing (max ~160 words) of only the concrete, sourced facts that would move a prediction. No filler, no restating the question, no betting advice — just the research. If little relevant is found, say so in one line.`;
}

// STOCK research prompt — the equity analogue: price, move, earnings, the analyst
// consensus (reported as data), and catalysts. Strictly factual/observational; a
// stock is a security, so no recommendation, no "should buy/sell", no price target
// framed as advice — just the sourced facts and where they sit vs the market.
function stockPrompt(subject: string): string {
  return `You are an equity research analyst preparing a factual briefing on the stock: "${subject}".

Search the web for the most recent, decision-relevant facts. Report, as available:
- current share price and recent move (today / past week)
- most recent earnings result vs expectations, and the next earnings date
- the current sell-side analyst CONSENSUS rating and average price target (report these as data — attribute them, do not endorse them)
- any fresh catalyst or news in the last few days (product, guidance, regulatory, macro)

Write a tight briefing (max ~160 words) of only concrete, sourced facts. No filler, no restating the question, and NO investment advice or recommendation of any kind — just the research. If little relevant is found, say so in one line.`;
}

// Fallback researcher: the Claude API with its server-side web search tool. Used
// when Venice is unfunded/unauthorised (401/402) or has no key. Sources are the
// URLs the search tool actually returned — an unsourced brief is still rejected.
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-opus-5";
const ANTHROPIC_IN = 5 / 1_000_000;
const ANTHROPIC_OUT = 25 / 1_000_000;
const WEB_SEARCH_USD = 0.01; // $10 per 1,000 searches
const VENICE_DEAD_MS = 10 * 60_000;
let veniceDeadUntil = 0;
let anthropicClient: Anthropic | null = null;

class VeniceUnfundedError extends Error {}

async function anthropicResearch(promptText: string, budget: BudgetGuard): Promise<ResearchBrief | null> {
  if (!config.anthropicApiKey) return null;
  anthropicClient ??= new Anthropic({ apiKey: config.anthropicApiKey, timeout: 120_000, maxRetries: 1 });
  const res = await anthropicClient.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 8000,
    output_config: { effort: "low" },
    tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 3 }],
    messages: [{ role: "user", content: promptText }],
  });
  const searches = res.usage.server_tool_use?.web_search_requests ?? 0;
  budget.register("anthropic:research", (res.usage.input_tokens ?? 0) * ANTHROPIC_IN + (res.usage.output_tokens ?? 0) * ANTHROPIC_OUT + searches * WEB_SEARCH_USD);
  const urls = new Set<string>();
  const parts: string[] = [];
  for (const block of res.content) {
    if (block.type === "text") {
      parts.push(block.text);
      for (const c of block.citations ?? []) {
        const u = (c as { url?: string }).url;
        if (u) urls.add(u);
      }
    } else if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
      for (const r of block.content) if (r.type === "web_search_result" && r.url) urls.add(r.url);
    }
  }
  const brief = parts.join("\n").trim();
  const sources = [...urls].slice(0, 6);
  if (!brief || sources.length === 0) return null;
  return { brief, sources };
}

async function research(promptText: string, budget: BudgetGuard): Promise<ResearchBrief | null> {
  if (config.veniceApiKey && Date.now() >= veniceDeadUntil) {
    try {
      return await veniceResearch(promptText, budget);
    } catch (err) {
      if (!(err instanceof VeniceUnfundedError)) throw err;
      veniceDeadUntil = Date.now() + VENICE_DEAD_MS;
      console.error(`venice research: ${err.message} — falling back to ${ANTHROPIC_MODEL} web search`);
    }
  }
  return anthropicResearch(promptText, budget);
}

async function veniceResearch(promptText: string, budget: BudgetGuard): Promise<ResearchBrief | null> {
  if (!config.veniceApiKey) return null;
  const res = await fetch("https://api.venice.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.veniceApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      // disable_thinking: this is a reasoning model — without it, thinking eats the
      // token budget and content comes back empty (10 citations, no brief).
      venice_parameters: {
        enable_web_search: "on",
        enable_web_citations: true,
        disable_thinking: true,
        strip_thinking_response: true,
      },
      messages: [{ role: "user", content: promptText }],
      max_tokens: 1000,
    }),
    signal: AbortSignal.timeout(75_000),
  });
  if (!res.ok) {
    if (res.status === 401 || res.status === 402) throw new VeniceUnfundedError(`HTTP ${res.status}`);
    console.error(`venice research: HTTP ${res.status}`);
    return null;
  }
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    venice_parameters?: { web_search_citations?: Array<{ url?: string }> };
  };

  const usage = json.usage;
  if (usage) {
    budget.register(
      "venice:research",
      (usage.prompt_tokens ?? 0) * INPUT_USD_PER_TOKEN + (usage.completion_tokens ?? 0) * OUTPUT_USD_PER_TOKEN
    );
  }
  const brief = json.choices?.[0]?.message?.content?.trim() ?? "";
  const sources = [...new Set((json.venice_parameters?.web_search_citations ?? []).map((c) => c.url).filter((u): u is string => !!u))].slice(0, 6);
  // Only trust research actually SOURCED from the web — an unsourced brief is just
  // stale model knowledge that can contradict the live market.
  if (!brief || sources.length === 0) return null;
  return { brief, sources };
}

/** Research any subject string (cached 10m). The reusable core. */
export async function researchSubject(subject: string, budget: BudgetGuard): Promise<ResearchBrief | null> {
  if (!subject.trim()) return null;
  const key = cacheKey("research", subject.toLowerCase());
  const cached = cacheGet<ResearchBrief>(key);
  if (cached !== undefined) return cached;
  try {
    const out = await research(prompt(subject), budget);
    if (out) cacheSet(key, out);
    return out;
  } catch (err) {
    console.error(`research: ${err}`);
    return null; // research is additive — never fail the read on it
  }
}

/** Equity research for the stocks lens (separate cache namespace + prompt). */
export async function researchStock(subject: string, budget: BudgetGuard): Promise<ResearchBrief | null> {
  if (!subject.trim()) return null;
  const key = cacheKey("research:stock", subject.toLowerCase());
  const cached = cacheGet<ResearchBrief>(key);
  if (cached !== undefined) return cached;
  try {
    const out = await research(stockPrompt(subject), budget);
    if (out) cacheSet(key, out);
    return out;
  } catch (err) {
    console.error(`stock research: ${err}`);
    return null;
  }
}

export async function researchFor(resolved: Resolved, budget: BudgetGuard): Promise<ResearchBrief | null> {
  // Research adds most value for event/narrative subjects; token diligence is
  // already covered by the onchain lenses.
  if (resolved.type !== "narrative") return null;
  return researchSubject(resolved.name, budget);
}

if (isCliEntry(import.meta.url)) {
  const budget = new BudgetGuard();
  const out = await researchFor({ type: "narrative", name: process.argv[2] ?? "spain vs portugal 2026 world cup" }, budget);
  console.log(JSON.stringify(out, null, 2));
  console.log(`cost: $${budget.total().toFixed(4)}`);
}
