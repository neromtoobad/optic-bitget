import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import type { DeskVerdict } from "../desk/types.js";
import { join } from "node:path";
import satori from "satori";
import { html } from "satori-html";
import { Resvg } from "@resvg/resvg-js";
import type { StockVerdict, TouchGrassVerdict } from "../types.js";
import { generateBackground } from "./venice.js";

type AnyVerdict = StockVerdict | TouchGrassVerdict | DeskVerdict;
import { BudgetGuard } from "../pipeline/budget.js";
import { config } from "../config.js";
import { isCliEntry } from "../fixtures.js";

export interface CardResult {
  card_url: string;
  pending: boolean;
}

const W = 1200;
const H = 672;
const CARDS_DIR = config.cardsDir; // on Railway this lives on the mounted volume

const AMBER = "#f5a623";
// Top-right mark: which agent platform this card was made on.
const BRAND_RIGHT = "BITGET AI · RESEARCH DESK";
const INK = "#e8ebf2";
const MUTE = "#6d7688";
const SUB = "#8a93a6";

const font = (f: string) => readFileSync(join(process.cwd(), "assets/fonts", f));
const FONTS = [
  { name: "Space Grotesk", data: font("sg-500.woff"), weight: 500 as const, style: "normal" as const },
  { name: "Space Grotesk", data: font("sg-700.woff"), weight: 700 as const, style: "normal" as const },
  { name: "IBM Plex Mono", data: font("ipm-400.woff"), weight: 400 as const, style: "normal" as const },
  { name: "IBM Plex Mono", data: font("ipm-500.woff"), weight: 500 as const, style: "normal" as const },
  { name: "IBM Plex Mono", data: font("ipm-600.woff"), weight: 600 as const, style: "normal" as const },
];

// ── formatting ────────────────────────────────────────────────────────

const fmtPrice = (n: number | null): string => {
  if (n === null) return "—";
  if (n >= 1000) return `$${Math.round(n).toLocaleString("en-US")}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toPrecision(2).replace(/e-?\d+$/, (m) => m)}`;
};

const fmtUsd = (n: number | null): string => {
  if (n === null) return "—";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${Math.round(n)}`;
};

const fmtPct = (n: number | null, signed = false): string =>
  n === null ? "—" : `${signed && n > 0 ? "+" : ""}${Math.round(n * 10) / 10}%`;

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const trunc = (s: string, max: number): string => (s.length <= max ? s : s.slice(0, max - 1).trimEnd() + "…");

// Length-aware display sizing — long strings step the font down so text always
// fits inside the fixed 1200x672 card instead of crowding or spilling off it.
const titleSize = (s: string): number => (s.length > 26 ? 40 : s.length > 18 ? 48 : 56);
const verdictSize = (s: string): number => (s.length > 150 ? 16.5 : s.length > 112 ? 18 : 20);
const statSize = (s: string): number => (s.length > 19 ? 21 : s.length > 12 ? 26 : 32);

const title = (v: AnyVerdict): string => {
  if (v.resolved.type === "stock") return trunc(((v as StockVerdict).stock?.ticker ?? v.resolved.name).toUpperCase(), 40);
  if (v.resolved.type === "desk") return trunc(((v as DeskVerdict).evidence.ticker || v.resolved.name).toUpperCase(), 40);
  const name = v.resolved.name;
  return trunc(name.length <= 3 ? name.toUpperCase() : name[0].toUpperCase() + name.slice(1), 40);
};

const dateLine = (): string =>
  new Date()
    .toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    .toLowerCase();

// ── chips ─────────────────────────────────────────────────────────────

interface Chip {
  lens: string;
  stat: string;
  color: string;
  sub: string;
}

function stockChips(v: StockVerdict): Chip[] {
  const s = v.stock;
  const tk = s?.tokenized;
  const top = v.prediction?.markets?.[0];
  return [
    tk?.venue === "perpetual"
      ? {
          // Computed leg: basis to the underlying's index, funding, and whether
          // the cash market is even open — the perp's whole story in one line.
          lens: "bitget · rToken perpetual",
          stat: fmtPrice(tk.price),
          color: "#4be3c3",
          sub: `${tk.symbol} · basis ${fmtPct(tk.basis_pct ?? null, true)} · funding ${fmtPct(tk.funding_annualized_pct ?? null, true)}/yr · US ${tk.us_session_open ? "open" : "closed"}`,
        }
      : {
          lens: `${config.exchange} · tokenized share`,
          stat: tk ? fmtPrice(tk.price) : "not listed",
          color: "#4be3c3",
          sub: tk
            ? `${tk.symbol} · ${fmtPct(tk.chg_24h, true)} 24h · liq ${fmtUsd(tk.liquidity)}`
            : "no tokenized share listed for this name",
        },
    {
      lens: "equity · research",
      stat: trunc(s?.consensus_tag || "—", 16),
      color: "#f5c944",
      sub: trunc(s?.analyst_consensus || s?.market_snapshot || "no fresh equity research", 46),
    },
    top
      ? {
          lens: "prediction · polymarket",
          stat: fmtPct(top.yes_price * 100),
          color: "#ff8a3d",
          sub: trunc(top.question, 46),
        }
      : {
          lens: "catalyst · ahead",
          stat: s?.catalysts?.length ? `${s.catalysts.length} flagged` : "clear",
          color: "#ff8a3d",
          sub: trunc(s?.catalysts?.[0] || "no prediction market prices this", 46),
        },
  ];
}

const WELLNESS_COLOR = (score: number | null): string =>
  score === null ? MUTE : score >= 65 ? "#4be3c3" : score >= 45 ? "#f5c944" : "#ff5a5a";

function touchgrassChips(v: TouchGrassVerdict): Chip[] {
  const w = v.wellness;
  const p = v.protocol;
  if (!w) return [];
  return [
    {
      lens: "nights · 00–06 local",
      stat: `${w.stats.night_pct}%`,
      color: w.stats.night_pct >= 15 ? "#ff8a3d" : "#4be3c3",
      sub:
        w.patterns.find((x) => x.id === "late_night")?.stat ??
        "nights are for sleep — the chain waits",
    },
    {
      lens: "days onchain · 90d",
      stat: `${w.stats.active_days}/90`,
      color: w.stats.active_days >= 63 ? "#ff8a3d" : w.stats.active_days >= 45 ? "#f5c944" : "#4be3c3",
      sub: `longest offchain break: ${w.stats.longest_break_h >= 48 ? `${Math.round(w.stats.longest_break_h / 24)}d` : `${Math.round(w.stats.longest_break_h)}h`}`,
    },
    {
      lens: "gym window · quietest",
      stat: p?.move.window ?? "open",
      color: "#4be3c3",
      sub: trunc(p?.grass[0] ?? "protocol in the full read", 46),
    },
  ];
}

function deskChips(v: DeskVerdict): Chip[] {
  const g = v.evidence.gap;
  const j = v.judge;
  const cov = v.evidence.coverage;
  return [
    {
      // The computed leg, in one line: what the perp is doing relative to its underlying.
      lens: "bitget · rToken perpetual",
      stat: v.evidence.perp ? fmtPrice(v.evidence.perp.price) : "not listed",
      color: "#4be3c3",
      sub: g ? `basis ${fmtPct(g.basis_pct, true)} · funding ${fmtPct(g.funding_annualized_pct, true)}/yr · US ${g.session}` : "no Bitget perpetual for this name",
    },
    {
      lens: "evidence · coverage",
      stat: `${cov.ok}/${cov.total}`,
      color: "#f5c944",
      sub: `${cov.computed_ok} rows computed by code · ${v.debated ? `${v.transcript.length} turns argued, ${j?.struck.length ?? 0} struck` : v.clarifying_question ? "asked one question first" : "no debate needed"}`,
    },
    {
      lens: "judge · verdict",
      stat: j ? trunc(j.call.replace(/_/g, " "), 16) : "—",
      color: "#ff8a3d",
      sub: trunc(v.clarifying_question || j?.strongest_attack || j?.what_is_priced_in || v.verdict_line, 46),
    },
  ];
}

// ── template ──────────────────────────────────────────────────────────

function template(v: AnyVerdict): ReturnType<typeof html> {
  const isStock = v.resolved.type === "stock";
  const isTouch = v.resolved.type === "touchgrass";
  const isDesk = v.resolved.type === "desk";

  // Hero panel for the "big number" modes (verdict / stock / rug / timing).
  // "GAP" = the divergence score, in plain language (how far apart the markets are).
  let heroLabel = "GAP";
  let heroNum: number | null = null;
  let heroSuffix = "/100";
  let heroDir: string | null = null;
  let heroColor = AMBER;
  let heroTicks = true;
  if (isTouch) {
    const w = (v as TouchGrassVerdict).wellness;
    heroLabel = "WELLNESS";
    heroNum = w ? w.score : null;
    heroDir = w ? w.persona.toLowerCase() : null;
    heroColor = WELLNESS_COLOR(w ? w.score : null);
  } else if (isDesk) {
    // The hero is the judge's capped probability that the thesis holds — a
    // number the scoreboard will later grade, not a score of the company.
    const dv = v as DeskVerdict;
    const j = dv.judge;
    const a = dv.evidence.analogs;
    if (j) {
      heroLabel = "P(HOLDS)";
      heroSuffix = "%";
      heroNum = Math.round(j.p_thesis_holds * 100);
      heroDir = `${j.call.replace(/_/g, " ")} · confidence ${Math.round(j.confidence * 100)}%${a?.base_rate_p != null ? ` · base rate ${Math.round(a.base_rate_p * 100)}%` : ""}`;
    } else if (a?.base_rate_p != null) {
      // No judge: the archive's base rate is the desk's forecast, and says so.
      heroLabel = "BASE RATE";
      heroSuffix = "%";
      heroNum = Math.round(a.base_rate_p * 100);
      heroDir = `${a.n} ${a.kind} windows · median ${a.median_move_pct}% · no model`;
    } else {
      heroLabel = "P(HOLDS)";
      heroSuffix = "";
      heroNum = null;
      heroDir = dv.clarifying_question ? "one question first" : "computed only · no model";
    }
    heroTicks = heroNum !== null;
  } else if (isStock) {
    const div = (v as StockVerdict).stock?.divergence ?? null;
    heroNum = div ? div.score : null;
    heroDir = div ? div.direction.replace(/_/g, " ") : null;
  }
  const ticksOn = heroNum === null ? 0 : Math.min(10, Math.round(heroNum / 10));

  const chips = isStock ? stockChips(v as StockVerdict) : isDesk ? deskChips(v as DeskVerdict) : touchgrassChips(v as TouchGrassVerdict);
  const kicker = isStock ? "stocks desk · cross-market" : isDesk ? "research desk · thesis vs evidence" : "onchain wellness · 90d read";

  const ret = (pos: string) =>
    `<div style="display:flex;position:absolute;width:26px;height:26px;${pos}border-color:rgba(232,235,242,.5);border-style:solid;"></div>`;

  // NOTE: no background image here — satori is pathologically slow parsing large
  // data-URI images (~85s). The Venice bg is injected into the SVG post-satori
  // and rasterized by resvg (native decoder). Root stays transparent.
  return html(`<div style="display:flex;flex-direction:column;width:${W}px;height:${H}px;font-family:'Space Grotesk';position:relative;color:${INK};">
  <div style="display:flex;position:absolute;top:0;left:0;width:${W}px;height:${H}px;background-image:radial-gradient(circle at 30% 40%, rgba(5,7,13,.92) 0%, rgba(5,7,13,.55) 55%, rgba(5,7,13,.25) 100%);"></div>
  ${ret("top:26px;left:26px;border-width:1.5px 0 0 1.5px;")}
  ${ret("top:26px;right:26px;border-width:1.5px 1.5px 0 0;")}
  ${ret("bottom:26px;left:26px;border-width:0 0 1.5px 1.5px;")}
  ${ret("bottom:26px;right:26px;border-width:0 1.5px 1.5px 0;")}

  <div style="display:flex;flex-direction:column;position:absolute;top:0;left:0;width:${W}px;height:${H}px;padding:58px 64px 48px;">
    <div style="display:flex;justify-content:space-between;align-items:baseline;font-family:'IBM Plex Mono';font-size:14px;letter-spacing:3px;color:${MUTE};">
      <div style="display:flex;font-weight:600;letter-spacing:4px;color:${INK};">${isTouch ? `TOUCH<span style="color:#4be3c3;">GRASS</span>` : `OPTIC A<span style="color:${AMBER};">I</span>`}</div>
      <div style="display:flex;">${kicker.toUpperCase()} · ${dateLine().toUpperCase()}</div>
      <div style="display:flex;">${BRAND_RIGHT}</div>
    </div>

    <div style="display:flex;margin-top:44px;">
      <div style="display:flex;flex-direction:column;flex:1;padding-right:40px;overflow:hidden;">
        <div style="display:flex;font-size:${titleSize(title(v))}px;line-height:1.05;font-weight:700;letter-spacing:-1px;">${esc(title(v))}</div>
        <div style="display:flex;margin-top:20px;font-size:${verdictSize(trunc(v.verdict_line, 170))}px;line-height:1.5;color:#aab2c2;max-width:560px;max-height:150px;overflow:hidden;">${esc(trunc(v.verdict_line, 170))}</div>
      </div>
      <div style="display:flex;flex-direction:column;width:300px;align-items:flex-end;">
        ${
            `<div style="display:flex;font-family:'IBM Plex Mono';font-size:13px;letter-spacing:4px;color:${MUTE};">${heroLabel}</div>
               <div style="display:flex;align-items:baseline;margin-top:8px;">
                 <div style="display:flex;font-size:140px;line-height:0.95;font-weight:700;letter-spacing:-5px;color:${heroColor};">${heroNum ?? "—"}</div>
                 ${heroSuffix ? `<div style="display:flex;font-size:42px;color:${MUTE};font-weight:500;">${heroSuffix}</div>` : ""}
               </div>
               <div style="display:flex;font-family:'IBM Plex Mono';margin-top:10px;font-size:14px;color:#aab2c2;">${esc(heroDir ?? "")}</div>
               ${
                 heroTicks
                   ? `<div style="display:flex;margin-top:16px;">
                 ${Array.from({ length: 10 }, (_, i) => `<div style="display:flex;width:14px;height:5px;margin-left:5px;background-color:${i < ticksOn ? heroColor : "rgba(255,255,255,.14)"};"></div>`).join("")}
               </div>`
                   : ""
               }`
        }
      </div>
    </div>

    <div style="display:flex;margin-top:auto;border-top:1px solid rgba(255,255,255,.14);">
      ${chips
        .map(
          (c, i) => `
        <div style="display:flex;flex-direction:column;flex:1;padding:22px ${i < 2 ? "36px" : "0"} 0 ${i > 0 ? "36px" : "0"};${i > 0 ? "border-left:1px solid rgba(255,255,255,.14);" : ""}overflow:hidden;">
          <div style="display:flex;align-items:center;font-family:'IBM Plex Mono';font-size:12px;letter-spacing:3px;color:${MUTE};max-height:34px;overflow:hidden;"><div style="display:flex;width:7px;height:7px;margin-right:10px;background-color:${AMBER};"></div>${esc(c.lens.toUpperCase())}</div>
          <div style="display:flex;font-family:'IBM Plex Mono';font-size:${statSize(c.stat)}px;line-height:1.15;font-weight:600;margin-top:8px;color:${c.color};max-height:76px;overflow:hidden;">${esc(c.stat)}</div>
          <div style="display:flex;font-size:14px;line-height:1.45;color:${SUB};margin-top:5px;max-height:42px;overflow:hidden;">${esc(c.sub)}</div>
        </div>`
        )
        .join("")}
    </div>
  </div>
</div>`);
}

// ── renderer ──────────────────────────────────────────────────────────

/**
 * Phase 3 renderer: Venice background (locked style) + satori/resvg composite.
 * Venice failure degrades to the dark base + vignette — card always renders.
 */
export async function renderCard(
  readId: string,
  verdict: AnyVerdict,
  budget: BudgetGuard
): Promise<CardResult> {
  const t0 = Date.now();
  const mark = (s: string) => console.error(`  [card ${readId.slice(0, 8)}] ${s} +${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const bg = await generateBackground(budget, verdict.resolved.type === "touchgrass" ? "touchgrass" : "optic");
  mark("venice");

  const svg = await satori(template(verdict) as Parameters<typeof satori>[0], {
    width: W,
    height: H,
    fonts: FONTS,
  });
  mark("satori");

  // Inject base + Venice bg under satori's (transparent-rooted) UI layer; resvg
  // decodes the raster natively — this is what keeps render time in seconds.
  const underlay =
    `<rect width="${W}" height="${H}" fill="#05070d"/>` +
    (bg
      ? `<image href="data:image/png;base64,${bg.toString("base64")}" width="${W}" height="${H}" opacity="0.75" preserveAspectRatio="xMidYMid slice"/>`
      : "");
  const composed = svg.replace(/(<svg[^>]*>)/, `$1${underlay}`);
  const png = new Resvg(composed, { fitTo: { mode: "width", value: W } }).render().asPng();
  mark("resvg");

  mkdirSync(CARDS_DIR, { recursive: true });
  writeFileSync(join(CARDS_DIR, `${readId}.png`), png);
  return { card_url: `${config.publicBaseUrl}/v1/card/${readId}`, pending: false };
}

export function cardPath(readId: string): string | null {
  const p = join(CARDS_DIR, `${readId}.png`);
  return existsSync(p) ? p : null;
}

if (isCliEntry(import.meta.url)) {
  const arg = process.argv[2] ?? "./fixtures/verdict.json";
  const verdict = JSON.parse(readFileSync(arg, "utf8")) as AnyVerdict;
  const budget = new BudgetGuard();
  const out = await renderCard("cli-test", verdict, budget);
  console.log(JSON.stringify(out, null, 2));
  console.log(`saved: ${cardPath("cli-test")} — cost $${budget.total().toFixed(4)}`);
}
