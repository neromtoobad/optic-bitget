import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import type { BudgetGuard } from "../pipeline/budget.js";

// The narrative brain runs on Venice's OpenAI-compatible text API — one key for
// both image generation and LLM work, no separate Anthropic account/credit. The
// export name (`structuredCall`) and signature are unchanged so every caller keeps
// working; only the provider behind it changed.
const ENDPOINT = "https://api.venice.ai/api/v1/chat/completions";

// Model-fallback chain: if one is overloaded, errors, or returns unparseable JSON
// we fall through to the next. Cheapest/most-reliable first (verified live). Open
// models vary run-to-run, so the parse is defensive and every caller keeps its own
// fallback for a bad/absent result.
// gemini-3-6-flash is the most reliable at clean JSON in testing; the lite model is
// the second try, then we retry the primary (failures are usually transient overload).
const MODELS = ["gemini-3-6-flash", "gemini-3-5-flash-lite", "gemini-3-6-flash"];

// Rough text-token pricing for the budget guard (Venice text is cheap); the guard
// only needs a sane number to keep per-read COGS bounded.
const IN_USD_PER_TOKEN = 0.6 / 1_000_000;
const OUT_USD_PER_TOKEN = 1.8 / 1_000_000;
const PER_MODEL_TIMEOUT_MS = 22_000;

// Fallback brain: the Claude API. Used when Venice is unfunded/unauthorised
// (401/402 — Venice's balance ran dry once mid-hackathon and every read 500'd),
// or when no Venice key is configured. Opus 5 by default (ANTHROPIC_MODEL to
// override); effort is mapped from the caller's hint so cheap classify calls
// stay cheap. Structured outputs (output_config.format) guarantee valid JSON.
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-opus-5";
const ANTHROPIC_IN_USD_PER_TOKEN = 5 / 1_000_000;
const ANTHROPIC_OUT_USD_PER_TOKEN = 25 / 1_000_000;
const VENICE_DEAD_MS = 10 * 60_000; // after a 401/402, skip Venice for a while
let veniceDeadUntil = 0;
let compatDeadUntil = 0;
let anthropicClient: Anthropic | null = null;

/** Structured-output schemas accept a JSON-schema subset: strip the keywords it rejects. */
function sanitizeSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeSchema);
  if (schema && typeof schema === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
      if (["maxLength", "minLength", "pattern", "format", "minimum", "maximum", "minItems", "maxItems"].includes(k)) continue;
      out[k] = sanitizeSchema(v);
    }
    return out;
  }
  return schema;
}

async function anthropicStructured<T>(
  opts: { label: string; system: string; user: string; schema: Record<string, unknown>; budget: BudgetGuard; maxTokens?: number; effort?: "low" | "medium" | "high" },
  single: { key: string; maxLength?: number } | null
): Promise<T> {
  if (!config.anthropicApiKey) throw new Error(`llm:${opts.label} — no ANTHROPIC_API_KEY for fallback`);
  anthropicClient ??= new Anthropic({ apiKey: config.anthropicApiKey, timeout: 90_000, maxRetries: 1 });
  const effort = opts.effort === "high" ? "high" : opts.effort === "low" ? "low" : "medium";
  const system = single
    ? `${opts.system}\n\nReply with ONLY the finished text on a single line — no quotes, no labels, no JSON, no markdown, no explanation.`
    : `${opts.system}\n\nReply with ONLY a single minified JSON object that conforms to this JSON Schema — no prose, no markdown.\nJSON Schema: ${JSON.stringify(opts.schema)}`;
  const base = {
    model: ANTHROPIC_MODEL,
    // Adaptive thinking shares max_tokens with the visible answer; leave room.
    max_tokens: Math.max((opts.maxTokens ?? 1024) * 2, 4096),
    system,
    messages: [{ role: "user" as const, content: opts.user }],
  };
  let res: Anthropic.Message;
  try {
    res = await anthropicClient.messages.create({
      ...base,
      output_config: single ? { effort } : { effort, format: { type: "json_schema", schema: sanitizeSchema(opts.schema) as Record<string, unknown> } },
    });
  } catch (err) {
    // A schema the structured-output validator rejects → plain prompt, same parse path.
    if (!(err instanceof Anthropic.BadRequestError) || single) throw err;
    res = await anthropicClient.messages.create({ ...base, output_config: { effort } });
  }
  const cost = (res.usage.input_tokens ?? 0) * ANTHROPIC_IN_USD_PER_TOKEN + (res.usage.output_tokens ?? 0) * ANTHROPIC_OUT_USD_PER_TOKEN;
  opts.budget.register(`anthropic:${opts.label}`, cost || 0.002);
  if (res.stop_reason === "refusal") throw new Error(`llm:${opts.label} — model declined (${res.stop_details?.category ?? "unspecified"})`);
  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  if (!text.trim()) throw new Error(`llm:${opts.label} — empty reply from ${ANTHROPIC_MODEL}`);
  if (single) {
    const line = cleanLine(text, single.maxLength);
    if (!line) throw new Error(`llm:${opts.label} — unusable single-line reply`);
    return sanitizeStrings({ [single.key]: line }) as T;
  }
  return sanitizeStrings(extractJson(text)) as T;
}
// Minimum completion budget. Measured: a bare classify burns ~427 tokens and a
// one-line tagline ~442 before any visible output — all reasoning, all counted.
const REASONING_FLOOR = 900;

/**
 * Model-emitted strings occasionally carry literal control characters mid-sentence
 * (a paid Daily Alpha read produced "at 52.4%\roster cuts…" — the \r swallowed
 * characters and broke the card layout). Verdict/headline fields are single-line
 * by design, so collapse every C0 control char run to one space, recursively.
 */
function sanitizeStrings<T>(value: T): T {
  if (typeof value === "string") {
    // eslint-disable-next-line no-control-regex
    return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/ {2,}/g, " ").trim() as unknown as T;
  }
  if (Array.isArray(value)) return value.map(sanitizeStrings) as unknown as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, sanitizeStrings(v)])) as unknown as T;
  }
  return value;
}

/**
 * Pull a JSON object out of a model reply and REPAIR it. Small models frequently
 * emit valid JSON with the closing brace(s) cut off (all fields present, no final
 * `}`), which naive parsing rejects. We walk from the first `{`, and if the direct
 * parse fails, close any open strings/brackets/braces and drop trailing commas.
 */
function extractJson(content: string): unknown {
  const cleaned = content.replace(/```(?:json)?/gi, "");
  const start = cleaned.indexOf("{");
  if (start < 0) throw new Error("no JSON object in reply");

  // Fast path: a well-formed object with a matching close.
  const end = cleaned.lastIndexOf("}");
  if (end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      /* fall through to repair */
    }
  }

  // Repair path: balance from the first `{`.
  const s = cleaned.slice(start);
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  let out = "";
  for (const ch of s) {
    out += ch;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
    else if (ch === "}" || ch === "]") stack.pop();
  }
  if (inStr) out += '"';
  out = out.replace(/,\s*$/, ""); // dangling comma from a cut-off field list
  while (stack.length) out += stack.pop();
  return JSON.parse(out);
}

/**
 * If a schema is exactly one required string property, return its {key, maxLength}.
 * For those we skip JSON entirely — small models reliably return a bare line but
 * garble the JSON wrapper for short creative outputs — and clean/wrap the reply.
 */
function singleStringField(schema: Record<string, unknown>): { key: string; maxLength?: number } | null {
  const props = schema.properties as Record<string, { type?: string; maxLength?: number }> | undefined;
  const req = schema.required as string[] | undefined;
  if (props && req && req.length === 1 && Object.keys(props).length === 1) {
    const k = req[0];
    if (props[k]?.type === "string") return { key: k, maxLength: props[k].maxLength };
  }
  return null;
}

/** Clean a bare one-line reply: drop fences, wrapping quotes, and leading labels. */
function cleanLine(content: string, maxLength?: number): string {
  let s = content.replace(/```[a-z]*\n?/gi, "").trim();
  s = s.split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? ""; // first real line
  s = s.replace(/^(?:here(?:'s| is)[^:]*:|tagline:|line:|answer:|output:|format\**:)\s*/i, "");
  s = s.replace(/^["'`*]+|["'`*]+$/g, "").trim();
  if (maxLength && s.length > maxLength) {
    s = s.slice(0, maxLength);
    const lastSpace = s.lastIndexOf(" ");
    if (lastSpace > maxLength * 0.6) s = s.slice(0, lastSpace); // cut on a word boundary
  }
  // Always drop dangling punctuation — a mid-sentence cut ("…and market research,"
  // or "…smart-") reads as broken on a card or a video beat, whatever caused it.
  s = s.replace(/[\s,;:—–-]+$/, "").trim();
  return s;
}

/**
 * Structured call: schema-constrained JSON out. The schema is injected into the
 * system prompt (Venice models honour that more reliably than response_format,
 * whose support is inconsistent across the model zoo); the reply's JSON is then
 * extracted and parsed. Actual token cost is registered with the read's budget.
 */
export async function structuredCall<T>(opts: {
  label: string;
  system: string;
  user: string;
  schema: Record<string, unknown>;
  budget: BudgetGuard;
  maxTokens?: number;
  effort?: "low" | "medium" | "high"; // accepted for compatibility; Venice has no effort knob
}): Promise<T> {
  // Single-string outputs (taglines, one-liners): ask for the bare line, not JSON —
  // small models garble the wrapper for short creative text. Everything else: JSON.
  const single = singleStringField(opts.schema);
  const system = single
    ? `${opts.system}\n\nReply with ONLY the finished text on a single line — no quotes, no labels, no JSON, no markdown, no explanation.`
    : `${opts.system}\n\nReply with ONLY a single minified JSON object that conforms to this JSON Schema — ` +
      `no prose, no explanation, no markdown, no code fences.\nJSON Schema: ${JSON.stringify(opts.schema)}`;

  // Provider order: an OpenAI-compatible endpoint if configured (Bitget's Qwen
  // gateway), then Venice, then Claude. Each is tried across its model list.
  const compatUsable = !!config.openaiCompat.baseUrl && !!config.openaiCompat.apiKey && Date.now() >= compatDeadUntil;
  const veniceUsable = !!config.veniceApiKey && Date.now() >= veniceDeadUntil;
  if (!compatUsable && !veniceUsable) {
    if (!config.anthropicApiKey) throw new Error(`llm:${opts.label} — no usable OPENAI_COMPAT_*/VENICE_API_KEY and no ANTHROPIC_API_KEY`);
    return anthropicStructured<T>(opts, single);
  }
  const providers: Array<{ name: string; endpoint: string; key: string; models: string[] }> = [];
  if (compatUsable) providers.push({ name: "compat", endpoint: `${config.openaiCompat.baseUrl}/chat/completions`, key: config.openaiCompat.apiKey, models: [config.openaiCompat.model] });
  if (veniceUsable) providers.push({ name: "venice", endpoint: ENDPOINT, key: config.veniceApiKey, models: MODELS });

  let lastErr: unknown;
  let veniceDead = false;
  for (const { name: providerName, endpoint, key, models } of providers) for (const model of models) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: opts.user },
          ],
          // These models spend ~430 completion tokens on internal reasoning BEFORE
          // emitting a single visible character, and that reasoning counts against
          // max_tokens. A caller asking for 120 (plenty for a one-line tagline) got
          // finish_reason:"length" and a line cut mid-word — which shipped into paid
          // reels. Floor the budget so the visible answer always has room; models
          // still stop on their own, so this costs nothing on short replies.
          max_tokens: Math.max(opts.maxTokens ?? 1024, REASONING_FLOOR),
          temperature: 0.6,
        }),
        signal: AbortSignal.timeout(PER_MODEL_TIMEOUT_MS),
      });
      if (!res.ok) {
        lastErr = new Error(`${providerName}:${model} HTTP ${res.status}`);
        if (res.status === 401 || res.status === 402) {
          // unfunded/unauthorised key — nothing on this provider will answer
          if (providerName === "venice") veniceDead = true;
          else compatDeadUntil = Date.now() + VENICE_DEAD_MS;
          break;
        }
        continue;
      }
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        error?: unknown;
      };
      const content = json.choices?.[0]?.message?.content;
      if (json.error || !content) {
        lastErr = new Error(`${model}: ${JSON.stringify(json.error ?? "no content")}`);
        continue;
      }
      let obj: unknown;
      if (single) {
        const line = cleanLine(content, single.maxLength);
        // Reject a reply that's still meta/garbage rather than ship it.
        if (!line || /[{}]|```|"?json"?\s*:/i.test(line)) {
          lastErr = new Error(`${model}: unusable single-line reply`);
          continue;
        }
        obj = { [single.key]: line };
      } else {
        obj = extractJson(content); // throws → next model
      }
      const parsed = sanitizeStrings(obj) as T;
      const cost = (json.usage?.prompt_tokens ?? 0) * IN_USD_PER_TOKEN + (json.usage?.completion_tokens ?? 0) * OUT_USD_PER_TOKEN;
      opts.budget.register(`${providerName}-text:${opts.label}`, cost || 0.002);
      return parsed;
    } catch (err) {
      lastErr = err; // overload / timeout / unparseable → try the next model
    }
  }
  if (veniceDead) {
    veniceDeadUntil = Date.now() + VENICE_DEAD_MS;
    console.error(`venice text: ${lastErr instanceof Error ? lastErr.message : lastErr} — falling back to ${ANTHROPIC_MODEL} for ${VENICE_DEAD_MS / 60_000} min`);
  }
  if (config.anthropicApiKey) {
    try {
      return await anthropicStructured<T>(opts, single);
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`llm:${opts.label} failed across ${providers.length} provider(s)${config.anthropicApiKey ? ` + ${ANTHROPIC_MODEL}` : ""} — ${lastErr instanceof Error ? lastErr.message : lastErr}`);
}
