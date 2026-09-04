import { config } from "../config.js";
import type { BudgetGuard } from "../pipeline/budget.js";

// Locked in Phase 0: model + style prompt are the card's visual identity.
// One style, every card — dealer.exe consistency, not per-card randomness.
const MODEL = "z-image-turbo";
export const VENICE_COST_USD = 0.01;
const STYLE_PROMPT =
  "Very dark near-black abstract composition, two thin luminous streams of light — one amber, one cyan — splitting apart and diverging toward opposite corners, fine particle trails, deep black negative space in the center-left, subtle film grain, minimal, elegant, cinematic, no text no letters no numbers";
// TouchGrass brand variant — one locked style per brand, same consistency rule.
const TOUCHGRASS_PROMPT =
  "Very dark near-black abstract composition, thin luminous blades of grass in neon green and soft teal rising from the bottom edge, faint dawn glow on the horizon, fine particle trails drifting upward, deep black negative space upper-left, subtle film grain, minimal, elegant, cinematic, no text no letters no numbers";

export type CardStyle = "optic" | "touchgrass";

/**
 * Venice background for a card. Returns raw PNG bytes, or null on any failure —
 * the renderer falls back to a gradient; the card never blocks the verdict.
 */
export async function generateBackground(budget: BudgetGuard, style: CardStyle = "optic"): Promise<Buffer | null> {
  if (!config.veniceApiKey) return null;
  try {
    budget.register("venice:card_bg", VENICE_COST_USD);
    const res = await fetch("https://api.venice.ai/api/v1/image/generate", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.veniceApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        prompt: style === "touchgrass" ? TOUCHGRASS_PROMPT : STYLE_PROMPT,
        width: 1200,
        height: 672,
        format: "png",
        safe_mode: false,
        hide_watermark: true,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      console.error(`venice bg: HTTP ${res.status}`);
      return null;
    }
    const json = (await res.json()) as { images?: string[] };
    const b64 = json.images?.[0];
    return b64 ? Buffer.from(b64, "base64") : null;
  } catch (err) {
    console.error(`venice bg: ${err}`);
    return null;
  }
}
