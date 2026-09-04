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
