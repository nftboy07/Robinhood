/**
 * Volume-spike scanner.
 *   1. token list   ← Blockscout (cached 30m)
 *   2. volume 5m/1h ← DexScreener (batched 30 CA)
 *   3. spike        ← 5m volume RISING vs previous scan (not merely high)
 *   4. safety       ← buy 0.01Ξ → sell back via Quoter (on-chain, not reputation)
 *
 * Why simulate the round-trip: no honeypot API covers chain 4663. The Quoter simulates a
 * real swap — a token that can't be sold (blacklist/tax) reverts or returns far too little.
 */
import { ethers } from "ethers";
import { cfg, C } from "../config.js";
import { watchProvider, usingOwnWatchRpc } from "../chain/client.js";
import { QUOTER_ABI } from "../chain/abis.js";
import { dataPath, readJson, writeJson } from "../util/files.js";
import { logger } from "../util/log.js";
import type { SpikeHit, SafetyResult } from "../types.js";
import type { WatchConfig } from "../config.js";

const log = logger("watch");
export { usingOwnWatchRpc };

const HIST_FILE = dataPath("watch-history.json");
const BS = "https://robinhoodchain.blockscout.com";
const DS = "https://api.dexscreener.com/latest/dex/tokens";

export const wcfg = (): WatchConfig => cfg.watch;

interface Hist {
  vol: Record<string, { vol5m: number; at: number }>;
  alerted: Record<string, number>;
}
const loadHist = (): Hist => readJson<Hist>(HIST_FILE, { vol: {}, alerted: {} });
const saveHist = (h: Hist): void => writeJson(HIST_FILE, h);

interface MarketRow {
  addr: string;
  symbol: string;
  vol5m: number;
  vol1h: number;
  vol24h: number;
  liq: number;
  fdv: number;
  priceUsd: number;
  chg5m: number;
  chg1h: number;
  url: string;
}

// ── 1. token list from Blockscout (cache 30m) ──
let tokenCache: { list: Array<{ addr: string; symbol: string }>; at: number } = { list: [], at: 0 };
async function tokenList(max: number): Promise<Array<{ addr: string; symbol: string }>> {
  if (Date.now() - tokenCache.at < 30 * 60_000 && tokenCache.list.length) return tokenCache.list;
  const out: Array<{ addr: string; symbol: string }> = [];
  let next: Record<string, string> | null = null;
  for (let page = 0; page < 10 && out.length < max; page++) {
    const q = next ? "?" + new URLSearchParams(next).toString() : "?type=ERC-20";
    const r: any = await fetch(`${BS}/api/v2/tokens${q}`, { signal: AbortSignal.timeout(15_000) })
      .then((x) => x.json())
      .catch(() => null);
    for (const t of r?.items ?? []) {
      const addr = t.address_hash || t.address;
      if (addr) out.push({ addr, symbol: t.symbol || "?" });
    }
    next = r?.next_page_params ?? null;
    if (!next) break;
  }
  tokenCache = { list: out.slice(0, max), at: Date.now() };
  return tokenCache.list;
}

// ── 2. market data from DexScreener, batched 30 ──
async function marketData(addrs: string[]): Promise<Record<string, MarketRow>> {
  const out: Record<string, MarketRow> = {};
  const chunks: string[][] = [];
  for (let i = 0; i < addrs.length; i += 30) chunks.push(addrs.slice(i, i + 30));

  const CONCURRENCY = 4;
  for (let i = 0; i < chunks.length; i += CONCURRENCY) {
    const batch = chunks.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (chunk) => {
        const res = await fetch(`${DS}/${chunk.join(",")}`, { signal: AbortSignal.timeout(15_000) }).catch(
          () => null,
        );
        if (res && "status" in res && res.status === 429) {
          await sleep(400);
          return fetch(`${DS}/${chunk.join(",")}`, { signal: AbortSignal.timeout(15_000) })
            .then((x) => x.json())
            .catch(() => null);
        }
        return res ? (res.json().catch(() => null) as Promise<any>) : null;
      }),
    );
    for (const r of results as any[]) {
      for (const p of r?.pairs ?? []) {
        if (p.chainId !== "robinhood") continue;
        const a = p.baseToken?.address;
        if (!a) continue;
        const liq = Number(p.liquidity?.usd || 0);
        if (out[a] && out[a]!.liq >= liq) continue;
        out[a] = {
          addr: a,
          symbol: p.baseToken?.symbol || "?",
          vol5m: Number(p.volume?.m5 || 0),
          vol1h: Number(p.volume?.h1 || 0),
          vol24h: Number(p.volume?.h24 || 0),
          liq,
          fdv: Number(p.fdv || 0),
          priceUsd: Number(p.priceUsd || 0),
          chg5m: Number(p.priceChange?.m5 || 0),
          chg1h: Number(p.priceChange?.h1 || 0),
          url: p.url || `https://dexscreener.com/robinhood/${p.pairAddress}`,
        };
      }
    }
  }
  return out;
}

// ── 4. on-chain safety: buy 0.01Ξ then sell back ──
export async function safetyCheck(tokenAddr: string, maxTaxPct = 6): Promise<SafetyResult> {
  const q = new ethers.Contract(C.quoter, QUOTER_ABI, watchProvider);
  const IN = ethers.parseEther("0.01");
  const perFee = await Promise.all(
    cfg.lp.feeTiers.map(async (fee) => {
      try {
        const buy = await q.quoteExactInputSingle!.staticCall({
          tokenIn: C.weth,
          tokenOut: tokenAddr,
          amountIn: IN,
          fee,
          sqrtPriceLimitX96: 0n,
        });
        if (buy[0] === 0n) return null;
        const sell = await q.quoteExactInputSingle!.staticCall({
          tokenIn: tokenAddr,
          tokenOut: C.weth,
          amountIn: buy[0],
          fee,
          sqrtPriceLimitX96: 0n,
        });
        const backPct = (Number(ethers.formatEther(sell[0])) / 0.01) * 100;
        const expected = Math.pow(1 - fee / 1e6, 2) * 100;
        const taxPct = expected - backPct;
        return { ok: true, fee, backPct, taxPct, reason: "" } as SafetyResult & { fee: number };
      } catch {
        return null;
      }
    }),
  );
  let best: (SafetyResult & { fee: number }) | null = null;
  for (const r of perFee) {
    if (r && (!best || r.backPct > best.backPct)) best = r;
  }
  if (!best) return { ok: false, backPct: 0, taxPct: 100, reason: "CANNOT SELL (simulation reverted) — honeypot" };
  if (best.taxPct > maxTaxPct) return { ...best, ok: false, reason: `hidden tax ~${best.taxPct.toFixed(1)}%` };
  return { ...best, ok: true, reason: `healthy (returned ${best.backPct.toFixed(1)}%)` };
}

// stablecoins have high volume but no momentum — filter by name AND behaviour
const STABLE_RE = /^(w?eth|usd[a-z]?|.*usd[a-z]?|dai|frax|tusd|susd|.*syrup.*)$/i;
function isStable(m: MarketRow): boolean {
  if (STABLE_RE.test(m.symbol)) return true;
  return m.priceUsd > 0.95 && m.priceUsd < 1.05 && Math.abs(m.chg1h) < 1;
}

/** Highest current 5m volume (non-stable) — used by /watch to show market context. */
export async function topVolumeNow(n = 3): Promise<MarketRow[]> {
  const w = wcfg();
  const toks = await tokenList(w.maxTokens);
  const md = await marketData(toks.map((t) => t.addr));
  return Object.values(md)
    .filter((m) => !isStable(m))
    .sort((a, b) => b.vol5m - a.vol5m)
    .slice(0, n);
}

/** One scan pass. Returns tokens that passed every filter + safety check. */
export async function scanOnce(onLog: (msg: string) => void = () => {}): Promise<SpikeHit[]> {
  const w = wcfg();
  const hist = loadHist();
  const toks = await tokenList(w.maxTokens);
  onLog(`cek ${toks.length} token…`);
  const md = await marketData(toks.map((t) => t.addr));
  const now = Date.now();
  const hits: SpikeHit[] = [];

  for (const m of Object.values(md)) {
    const prev = hist.vol[m.addr];
    const prevVol = prev?.vol5m ?? 0;
    hist.vol[m.addr] = { vol5m: m.vol5m, at: now };

    if (isStable(m)) continue;
    if (m.vol5m < w.minVol5m) continue;
    if (m.vol1h < w.minVol1h) continue;
    if (m.liq < w.minLiqUsd) continue;
    if (!prev) continue; // need a baseline to prove "rising"
    if (m.vol5m < prevVol * w.riseFactor) continue;
    if (now - (hist.alerted[m.addr] || 0) < w.cooldownMin * 60_000) continue;

    onLog(`spike: ${m.symbol} $${(m.vol5m / 1000).toFixed(0)}k/5m — uji keamanan…`);
    const safe = await safetyCheck(m.addr, w.maxTaxPct);
    if (!safe.ok) {
      onLog(`  ✗ ${m.symbol} ditolak: ${safe.reason}`);
      continue;
    }
    hist.alerted[m.addr] = now;
    hits.push({ ...m, prevVol5m: prevVol, safe });
  }
  saveHist(hist);
  if (hits.length) log.info(`${hits.length} spike lolos filter`);
  return hits;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
