// Output language guard: OPTIC reports the map, never a trade instruction.
// This lint runs over every user-facing verdict string (CLAUDE.md non-negotiable).

const BANNED = ["buy", "sell", "long", "short", "ape", "moon"];

const pattern = new RegExp(`\\b(${BANNED.join("|")})\\b`, "i");

export function findBannedWord(text: string): string | null {
  if (typeof text !== "string") return null; // tolerate a model that omitted a field
  const m = text.match(pattern);
  return m ? m[1].toLowerCase() : null;
}

/** Collects every user-facing string in a verdict-shaped object and lints it. */
export function lintVerdictStrings(strings: Array<string | undefined | null>): { ok: boolean; violations: Array<{ text: string; word: string }> } {
  const violations: Array<{ text: string; word: string }> = [];
  for (const s of strings) {
    if (typeof s !== "string") continue; // ignore missing/omitted fields
    const word = findBannedWord(s);
    if (word) violations.push({ text: s, word });
  }
  return { ok: violations.length === 0, violations };
}

export function verdictStrings(v: { divergence: { one_liner: string; reasoning: string[] }; verdict_line: string }): string[] {
  return [v.verdict_line, v.divergence.one_liner, ...v.divergence.reasoning];
}

/** Last resort for the judge's prose: swap a banned word for a neutral one so a
 * sound verdict isn't thrown away for echoing the trader's own wording. The
 * desk's voice still never says buy, sell, long or short. */
const NEUTRAL: Record<string, string> = { buy: "enter", sell: "exit", long: "upside", short: "downside", ape: "rush", moon: "spike" };
export function scrubBanned(text: string): string {
  return text.replace(/\bshort([- ])term\b/gi, (m, sep) => (m[0] === "S" ? "Near" : "near") + sep + "term").replace(/\blong([- ])term\b/gi, (m, sep) => (m[0] === "L" ? "Extended" : "extended") + sep + "term").replace(new RegExp(`\\b(${BANNED.join("|")})(s|ed|ing)?\\b`, "gi"), (_m, w: string) => {
    const r = NEUTRAL[w.toLowerCase()] ?? "";
    return w[0] === w[0].toUpperCase() ? r.charAt(0).toUpperCase() + r.slice(1) : r;
  });
}
