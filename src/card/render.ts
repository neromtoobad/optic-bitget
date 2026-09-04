import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import satori from "satori";
import { html } from "satori-html";
import { Resvg } from "@resvg/resvg-js";
import type { DailyVerdict, EdgeVerdict, RugVerdict, ScanVerdict, SmartMoneyVerdict, StockVerdict, TimingVerdict, TouchGrassVerdict, Verdict } from "../types.js";
import { generateBackground } from "./venice.js";

type AnyVerdict = Verdict | ScanVerdict | DailyVerdict | EdgeVerdict | SmartMoneyVerdict | StockVerdict | RugVerdict | TimingVerdict | TouchGrassVerdict;
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
const BRAND_RIGHT = config.exchange === "binance" ? "BINANCE AGENT OS" : "OKX.AI";
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
  if (v.resolved.type === "scan") return "Market scan";
  // Daily: a bespoke name (e.g. an event-day special "OPTIC'S CALL: …") takes the
  // headline; the pipeline's generic "daily alpha" keeps the standard title.
  if (v.resolved.type === "daily")
    return v.resolved.name && v.resolved.name !== "daily alpha" ? trunc(v.resolved.name, 44) : "Today's alpha";
  if (v.resolved.type === "edge") return "Edge radar";
  if (v.resolved.type === "smartmoney") return "Smart money";
  if (v.resolved.type === "stock") return trunc(((v as StockVerdict).stock?.ticker ?? v.resolved.name).toUpperCase(), 40);
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

function verdictChips(v: Verdict): Chip[] {
  const meme = v.venues.meme;
  const pred = v.venues.prediction;
  const att = v.attention;
  const topMarket = pred?.markets?.[0];
  const bn = v.venues.binance ?? null;
  // Binance edition: the exchange takes the first chip — spot price with the perps
  // positioning underneath — and social folds into the onchain chip's sub-line.
  if (bn) {
    const perps = bn.perps;
    const perpBits = [
      perps?.funding_rate != null ? `funding ${perps.funding_rate * 100 >= 0 ? "+" : ""}${(perps.funding_rate * 100).toFixed(3)}%` : null,
      perps?.open_interest_usd != null ? `OI ${fmtUsd(perps.open_interest_usd)}` : null,
      perps?.accounts_up_pct != null ? `${perps.accounts_up_pct}% up-skew` : null,
    ].filter((b): b is string => !!b);
    return [
      {
        lens: `binance · ${perps ? "spot + perps" : "spot"}`,
        stat: bn.spot ? fmtPrice(bn.spot.price) : perps?.mark_price != null ? fmtPrice(perps.mark_price) : "—",
        color: "#f0b90b",
        sub: perpBits.length ? perpBits.join(" · ") : bn.spot ? `${fmtPct(bn.spot.chg_24h, true)} 24h · ${fmtUsd(bn.spot.volume_24h_usd)} vol` : "no perp listed",
      },
      {
        lens: "onchain · binance web3",
        stat: meme ? fmtPrice(meme.price) : "asleep",
        color: "#4be3c3",
        sub: meme
          ? `${fmtPct(meme.chg_24h, true)} 24h · liq ${fmtUsd(meme.liquidity)}${att?.hotness != null ? ` · hype ${att.hotness}` : ""}`
          : att
            ? `social hype ${att.hotness ?? "—"} · ${att.trend}`
            : "no onchain market for this story",
      },
      {
        lens: "prediction · markets",
        stat: topMarket ? fmtPct(topMarket.yes_price * 100) : "unhedged",
        color: "#ff8a3d",
        sub: topMarket
          ? `yes-price · ${fmtUsd(topMarket.volume)} vol · ${pred!.markets.length} mkt${pred!.markets.length > 1 ? "s" : ""}`
          : "no outcome market prices this",
      },
    ];
  }
  return [
    {
      lens: "meme · onchain",
      stat: meme ? fmtPrice(meme.price) : "asleep",
      color: "#4be3c3",
      sub: meme
        ? `${fmtPct(meme.chg_24h, true)} 24h · liq ${fmtUsd(meme.liquidity)}`
        : "no onchain market for this story",
    },
    {
      lens: "prediction · polymarket",
      stat: topMarket ? fmtPct(topMarket.yes_price * 100) : "unhedged",
      color: "#ff8a3d",
      sub: topMarket
        ? `yes-price · ${fmtUsd(topMarket.volume)} vol · ${pred!.markets.length} mkt${pred!.markets.length > 1 ? "s" : ""}`
        : "no outcome market prices this",
    },
    {
      lens: "attention · social",
      stat: att?.hotness !== null && att !== null ? String(att.hotness) : "quiet",
      color: "#f5c944",
      sub: att
        ? `hotness · ${att.mentions_24h ?? 0} mentions · ${att.trend}`
        : "no social read on this subject",
    },
  ];
}

function scanChips(v: ScanVerdict): Chip[] {
  const top = v.scan.rising[0];
  const fresh = v.scan.fresh_trenches[0];
  const unlock = v.scan.unlock_calendar[0];
  return [
    {
      lens: "rising · social",
      stat: top ? `${top.symbol} ${top.accel_x ?? "?"}x` : "quiet",
      color: "#f5c944",
      sub: top ? `${top.mentions_1h ?? 0}/1h vs ${top.mentions_24h ?? 0}/24h` : "no accelerating narratives",
    },
    {
      lens: "fresh · trenches",
      stat: fresh ? fresh.symbol : "quiet",
      color: "#4be3c3",
      sub: fresh
        ? `${fmtUsd(fresh.volume_1h_usd)} 1h vol · ${fmtUsd(fresh.market_cap_usd)} mcap`
        : "no fresh launches with volume",
    },
    {
      lens: "unlocks · supply",
      stat: unlock ? "scheduled" : "clear",
      color: "#ff8a3d",
      sub: unlock ? trunc(unlock.title, 44) : "no major unlocks flagged",
    },
  ];
}

const CONF_COLOR: Record<string, string> = { high: "#4be3c3", medium: "#f5c944", watch: "#ff8a3d" };
const CAT_LABEL: Record<string, string> = {
  prediction: "prediction",
  meme_momentum: "meme momentum",
  supply_risk: "supply risk",
};

function dailyChips(v: DailyVerdict): Chip[] {
  return v.tips.slice(0, 3).map((t) => ({
    lens: `${CAT_LABEL[t.category] ?? t.category} · ${t.confidence}`,
    stat: trunc(t.headline, 26),
    color: CONF_COLOR[t.confidence] ?? "#f5c944",
    sub: trunc(t.research, 46),
  }));
}

function edgeChips(v: EdgeVerdict): Chip[] {
  return v.edges.slice(0, 3).map((e) => ({
    lens: `edge ${e.edge_score}/100`,
    stat: trunc(e.market_price, 26),
    color: e.edge_score >= 50 ? "#ff8a3d" : "#f5c944",
    sub: trunc(e.read, 46),
  }));
}

function smartChips(v: SmartMoneyVerdict): Chip[] {
  return v.flow.slice(0, 3).map((t) => ({
    lens: `${t.wallets} wallets`,
    stat: trunc(t.symbol, 14),
    color: "#4be3c3",
    sub: `${fmtUsd(t.buy_usd)} bought · ${t.market_cap_usd ? fmtUsd(t.market_cap_usd) : "?"} mcap`,
  }));
}

function stockChips(v: StockVerdict): Chip[] {
  const s = v.stock;
  const tk = s?.tokenized;
  const top = v.prediction?.markets?.[0];
  return [
    {
      lens: "okx · tokenized xstock",
      stat: tk ? fmtPrice(tk.price) : "not listed",
      color: "#4be3c3",
      sub: tk
        ? `${tk.symbol} · ${fmtPct(tk.chg_24h, true)} 24h · liq ${fmtUsd(tk.liquidity)}`
        : "no xStock on OKX for this name",
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

const RISK_COLOR = (lvl?: string): string =>
  lvl === "danger" ? "#ff5a5a" : lvl === "elevated" ? "#ff8a3d" : lvl === "caution" ? "#f5c944" : "#4be3c3";
const STAGE_COLOR = (s?: string): string =>
  s === "peaking" ? "#ff8a3d" : s === "igniting" ? "#4be3c3" : s === "building" ? "#f5c944" : s === "cooling" ? "#8a93a6" : MUTE;

const fmtAge = (hours: number | null): string => {
  if (hours === null) return "—";
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
};

function rugChips(v: RugVerdict): Chip[] {
  const r = v.risk;
  const flags = r?.flags ?? [];
  const pos = r?.positives ?? [];
  return [
    {
      lens: "risk level",
      stat: (r?.level ?? "—").toUpperCase(),
      color: RISK_COLOR(r?.level),
      sub: flags[0] ? trunc(flags[0], 46) : "no red flags found",
    },
    {
      lens: "red flags",
      stat: `${flags.length} flagged`,
      color: "#ff8a3d",
      sub: trunc(flags[1] ?? flags[0] ?? "clean scan", 46),
    },
    {
      lens: "positives",
      stat: `${pos.length} ok`,
      color: "#4be3c3",
      sub: trunc(pos[0] ?? "none noted", 46),
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

function timingChips(v: TimingVerdict): Chip[] {
  const t = v.timing;
  return [
    {
      lens: "stage",
      stat: (t?.stage ?? "—").toUpperCase(),
      color: STAGE_COLOR(t?.stage),
      sub: trunc(t?.read ?? "no timing read", 46),
    },
    {
      lens: "hotness · 24h",
      stat: t?.hotness != null ? String(Math.round(t.hotness)) : "—",
      color: "#f5c944",
      sub: t?.hotness_change_pct != null ? `${fmtPct(t.hotness_change_pct, true)} vs prior window` : "no change data",
    },
    {
      lens: "age",
      stat: fmtAge(t?.age_hours ?? null),
      color: "#4be3c3",
      sub: t?.engagement_change_pct != null ? `engagement ${fmtPct(t.engagement_change_pct, true)}` : "since launch",
    },
  ];
}

// ── template ──────────────────────────────────────────────────────────

function template(v: AnyVerdict): ReturnType<typeof html> {
  // RugVerdict/TimingVerdict share resolved.type "token" with Verdict, so detect
  // them by their unique fields (Verdict is the only one carrying `venues`).
  const has = (k: string): boolean => Object.prototype.hasOwnProperty.call(v, k);
  const isScan = v.resolved.type === "scan";
  const isDaily = v.resolved.type === "daily";
  const isEdge = v.resolved.type === "edge";
  const isSmart = v.resolved.type === "smartmoney";
  const isStock = v.resolved.type === "stock";
  const isTouch = v.resolved.type === "touchgrass";
  const isRug = !isStock && !isTouch && has("risk") && !has("venues");
  const isTiming = !isStock && !isTouch && has("timing") && !has("risk") && !has("venues");

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
  } else if (isRug) {
    const r = (v as RugVerdict).risk;
    heroLabel = "RISK";
    heroNum = r ? r.score : null;
    heroDir = r ? r.level : null;
    heroColor = RISK_COLOR(r?.level);
  } else if (isTiming) {
    const t = (v as TimingVerdict).timing;
    heroLabel = "HOTNESS";
    heroSuffix = "";
    heroNum = t?.hotness != null ? Math.round(t.hotness) : null;
    heroDir = t?.stage ?? null;
    heroColor = STAGE_COLOR(t?.stage);
    heroTicks = t?.hotness != null;
  } else if (isStock) {
    const div = (v as StockVerdict).stock?.divergence ?? null;
    heroNum = div ? div.score : null;
    heroDir = div ? div.direction.replace(/_/g, " ") : null;
  } else {
    const div = (v as Verdict).divergence;
    heroNum = div ? div.score : null;
    heroDir = div ? div.direction.replace(/_/g, " ") : null;
  }
  const ticksOn = heroNum === null ? 0 : Math.min(10, Math.round(heroNum / 10));

  const chips = isScan
    ? scanChips(v as ScanVerdict)
    : isDaily
      ? dailyChips(v as DailyVerdict)
      : isEdge
        ? edgeChips(v as EdgeVerdict)
        : isSmart
          ? smartChips(v as SmartMoneyVerdict)
          : isStock
            ? stockChips(v as StockVerdict)
            : isTouch
              ? touchgrassChips(v as TouchGrassVerdict)
              : isRug
                ? rugChips(v as RugVerdict)
                : isTiming
                  ? timingChips(v as TimingVerdict)
                  : verdictChips(v as Verdict);
  const kicker = isScan
    ? "market scan · discovery read"
    : isDaily
      ? "daily alpha · picks of the day"
      : isEdge
        ? "edge radar · mispricing scan"
        : isSmart
          ? "smart money · accumulation"
          : isStock
            ? "stocks desk · cross-market"
            : isTouch
              ? "onchain wellness · 90d read"
              : isRug
                ? "rug radar · safety scan"
                : isTiming
                  ? "narrative timing · lifecycle"
                  : "cross-market read";
  const scanTop = isScan ? (v as ScanVerdict).scan.rising[0] : null;
  const tipCount = isDaily
    ? (v as DailyVerdict).tips.length
    : isEdge
      ? (v as EdgeVerdict).edges.length
      : isSmart
        ? (v as SmartMoneyVerdict).flow.length
        : null;

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
          isDaily || isEdge || isSmart
            ? `<div style="display:flex;font-family:'IBM Plex Mono';font-size:13px;letter-spacing:4px;color:${MUTE};">${isEdge ? "EDGES" : isSmart ? "TOKENS" : "PICKS TODAY"}</div>
               <div style="display:flex;align-items:baseline;margin-top:8px;">
                 <div style="display:flex;font-size:140px;line-height:0.95;font-weight:700;letter-spacing:-5px;color:${AMBER};">${tipCount ?? "—"}</div>
               </div>
               <div style="display:flex;font-family:'IBM Plex Mono';margin-top:10px;font-size:14px;color:#aab2c2;">${isEdge ? "potential mispricings" : isSmart ? "under accumulation" : "research-backed calls"}</div>`
            : isScan
            ? `<div style="display:flex;font-family:'IBM Plex Mono';font-size:13px;letter-spacing:4px;color:${MUTE};">TOP ACCELERATION</div>
               <div style="display:flex;align-items:baseline;margin-top:8px;">
                 <div style="display:flex;font-size:110px;line-height:0.95;font-weight:700;letter-spacing:-4px;color:${AMBER};">${scanTop?.accel_x ?? "—"}</div>
                 <div style="display:flex;font-size:40px;color:${MUTE};font-weight:500;">x</div>
               </div>
               <div style="display:flex;font-family:'IBM Plex Mono';margin-top:10px;font-size:14px;color:#aab2c2;">${esc(scanTop ? `$${scanTop.symbol} mention rate vs 24h` : "no signal")}</div>`
            : `<div style="display:flex;font-family:'IBM Plex Mono';font-size:13px;letter-spacing:4px;color:${MUTE};">${heroLabel}</div>
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
  const verdict = JSON.parse(readFileSync(arg, "utf8")) as Verdict;
  const budget = new BudgetGuard();
  const out = await renderCard("cli-test", verdict, budget);
  console.log(JSON.stringify(out, null, 2));
  console.log(`saved: ${cardPath("cli-test")} — cost $${budget.total().toFixed(4)}`);
}
