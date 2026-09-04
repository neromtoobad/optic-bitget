import { cached } from "../db.js";
import type { BudgetGuard } from "../pipeline/budget.js";
import { isCliEntry } from "../fixtures.js";

// TOUCHGRASS lens — raw onchain activity for a wallet, timestamps only.
// Free public sources (Blockscout v2 for EVM, public RPC for Solana): the
// wellness read is behavior-over-time, so all it needs is when the wallet acts.

export interface WalletTx {
  ts: number; // unix seconds
  chain: string;
}

export interface WalletActivity {
  address: string;
  kind: "evm" | "solana";
  chains: string[]; // chains where activity was found
  txs: WalletTx[]; // newest first; EVM = outgoing only (wallet-initiated)
  sampled: boolean; // true when page caps were hit (very busy wallet)
}

const EVM_RE = /^0x[a-fA-F0-9]{40}$/;
const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function classifyAddress(q: string): "evm" | "solana" | null {
  if (EVM_RE.test(q)) return "evm";
  if (SOL_RE.test(q)) return "solana";
  return null;
}

const EVM_CHAINS = [
  { name: "ethereum", base: "https://eth.blockscout.com" },
  { name: "base", base: "https://base.blockscout.com" },
];
const MAX_PAGES = 3; // 50 txs/page — 150 per chain is plenty for a 90d behavior read
const SOL_RPC = "https://api.mainnet-beta.solana.com";
const FETCH_TIMEOUT_MS = 12_000;

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

async function evmChainTxs(base: string, chain: string, address: string): Promise<{ txs: WalletTx[]; sampled: boolean }> {
  const txs: WalletTx[] = [];
  // filter=from → wallet-initiated actions only; incoming transfers are other
  // people's behavior and must not count against this wallet's wellness.
  let params = `filter=from`;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = (await fetchJson(`${base}/api/v2/addresses/${address}/transactions?${params}`)) as {
      items?: Array<{ timestamp?: string }>;
      next_page_params?: Record<string, string | number> | null;
    };
    for (const item of data.items ?? []) {
      const ts = item.timestamp ? Date.parse(item.timestamp) / 1000 : NaN;
      if (Number.isFinite(ts)) txs.push({ ts, chain });
    }
    if (!data.next_page_params) return { txs, sampled: false };
    params =
      `filter=from&` +
      Object.entries(data.next_page_params)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join("&");
  }
  return { txs, sampled: true };
}

async function solanaTxs(address: string): Promise<{ txs: WalletTx[]; sampled: boolean }> {
  const data = (await fetchJson(SOL_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getSignaturesForAddress",
      params: [address, { limit: 1000 }],
    }),
  })) as { result?: Array<{ blockTime?: number | null }>; error?: { message?: string } };
  if (data.error) throw new Error(`solana rpc: ${data.error.message ?? "error"}`);
  const txs = (data.result ?? [])
    .map((s) => s.blockTime)
    .filter((t): t is number => typeof t === "number" && t > 0)
    .map((ts) => ({ ts, chain: "solana" }));
  return { txs, sampled: (data.result ?? []).length === 1000 };
}

/**
 * Fetch wallet activity. Returns null for a string that isn't a wallet address —
 * absence is signal, the pipeline reports it honestly. Chains that error are
 * skipped (a wallet with zero Base history must not fail the read).
 */
export async function walletActivity(query: string, budget: BudgetGuard): Promise<WalletActivity | null> {
  const address = query.trim();
  const kind = classifyAddress(address);
  if (!kind) return null;

  const { value } = await cached("wallet-activity", { address, kind }, async () => {
    budget.register(`wallet:${kind}`, 0); // free public APIs — logged, not billed
    if (kind === "solana") {
      const { txs, sampled } = await solanaTxs(address);
      return { address, kind, chains: txs.length ? ["solana"] : [], txs, sampled } satisfies WalletActivity;
    }
    const results = await Promise.allSettled(EVM_CHAINS.map((c) => evmChainTxs(c.base, c.name, address)));
    const txs: WalletTx[] = [];
    const chains: string[] = [];
    let sampled = false;
    let failures = 0;
    results.forEach((r, i) => {
      if (r.status === "fulfilled") {
        if (r.value.txs.length) chains.push(EVM_CHAINS[i].name);
        txs.push(...r.value.txs);
        sampled ||= r.value.sampled;
      } else {
        failures++;
      }
    });
    if (failures === results.length) throw new Error("all EVM explorers unreachable");
    txs.sort((a, b) => b.ts - a.ts);
    return { address, kind, chains, txs, sampled } satisfies WalletActivity;
  });
  return value;
}

if (isCliEntry(import.meta.url)) {
  const { BudgetGuard } = await import("../pipeline/budget.js");
  const address = process.argv[2];
  if (!address) {
    console.error("usage: npm run wallet -- <address>");
    process.exit(1);
  }
  const activity = await walletActivity(address, new BudgetGuard());
  if (!activity) {
    console.log("not a wallet address");
  } else {
    const preview = activity.txs.slice(0, 5).map((t) => `${new Date(t.ts * 1000).toISOString()} ${t.chain}`);
    console.log(
      JSON.stringify({ ...activity, txs: `${activity.txs.length} txs`, preview }, null, 2)
    );
  }
}
