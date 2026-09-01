import { ethers } from "ethers";
import { cfg, C } from "../config.js";
import { findPools, pickLpPool } from "../chain/pools.js";
import { openPosition, listPositions } from "../chain/positions.js";
import { swapWethToToken } from "../chain/swaps.js";
import { balances } from "../chain/holdings.js";
import { wallet, overrides } from "../chain/client.js";
import { WETH_ABI } from "../chain/abis.js";
import { trackNewMemeBuy } from "./strategy.js";
import { dataPath, readJson, writeJson } from "../util/files.js";
import { logger } from "../util/log.js";
import type { Candidate, Verdict } from "./radar.js";
import type { OpenResult, MintMode } from "../types.js";

const log = logger("autolp");
const STATE_FILE = dataPath("autolp-state.json");
const GAS_RESERVE = 0.005; // ETH kept untouched for gas

export interface AutoLpResult {
  opened: boolean;
  reason: string;
  token: string;
  symbol: string;
  sizeEth?: number;
  result?: OpenResult | any;
}

interface OpenRecord {
  ts: number;
  token: string;
  sizeEth: number;
  tokenId?: string | null;
  txHash?: string;
  mode?: string;
}

interface State {
  opens: OpenRecord[];
}

const load = (): State => readJson<State>(STATE_FILE, { opens: [] });
const save = (s: State): void => writeJson(STATE_FILE, s);

export async function maybeAutoLp(
  candidate: Candidate,
  verdict?: Verdict | null,
): Promise<AutoLpResult | null> {
  const a = cfg.autoLp;
  if (!a.enabled) return null;

  const skip = (reason: string): AutoLpResult => {
    log.info(`skip ${candidate.symbol}: ${reason}`);
    return { opened: false, reason, token: candidate.token, symbol: candidate.symbol };
  };

  // 1. source allowed
  if (!a.sources.includes(candidate.source)) return skip(`source ${candidate.source} not allowed`);

  // 2. Market Cap Ceiling: strict < $500k filter
  const g = verdict?.gmgn ?? null;
  const mcap = (g as any)?.marketCap ?? candidate.fdv ?? 0;
  if (a.maxMcapUsd > 0 && mcap > 0 && mcap > a.maxMcapUsd) {
    return skip(`market cap $${mcap.toFixed(0)} > $${a.maxMcapUsd} (max $500k ceiling)`);
  }

  // 3. High Initial Buy Pressure Fast-Path (< $100k MCAP or fresh launch)
  const isMicroCap = (mcap > 0 && mcap < 100_000) || candidate.source === "feed-new" || candidate.source === "noxa-curve" || candidate.source === "poke-ai";
  const hasBuyPressure = (candidate.vol5m ?? 0) > 0 || (candidate.onchainBackPct ?? 100) >= 90;

  if (isMicroCap && hasBuyPressure) {
    log.info(`⚡ [MICRO-CAP BUY PRESSURE TRIGGER (<$100k)] Fast-tracking ${candidate.symbol} (MCap: $${mcap.toFixed(0)})`);
  } else if (a.requireLlm) {
    // Standard LLM verdict gate for tokens between $100k - $500k
    if (!verdict?.llm) return skip("no LLM verdict");
    if (verdict.llm.action !== a.requireAction && verdict.llm.action !== "ape") return skip(`action ${verdict.llm.action} ≠ ${a.requireAction}`);
    if (verdict.llm.score < a.minScore) return skip(`score ${verdict.llm.score} < ${a.minScore}`);
  }

  // 4. GMGN hard safety filters
  if (a.requireGmgn && !g) return skip("GMGN required but not available");
  if (g) {
    if (g.isHoneypot === "yes" || (g.isHoneypot as unknown) === true) return skip("GMGN honeypot");
    const tax = Math.max((g.buyTax ?? 0) * 100, (g.sellTax ?? 0) * 100);
    if (tax > a.maxTaxPct) return skip(`tax ${tax.toFixed(1)}% > ${a.maxTaxPct}%`);
  }

  // 5. Liquidity floor
  const liq = g?.liquidityUsd ?? candidate.liq ?? 0;
  if (a.minLiqUsd > 0 && liq > 0 && liq < a.minLiqUsd) return skip(`liquidity $${liq.toFixed(0)} < $${a.minLiqUsd}`);

  // 6. Caps
  const now = Date.now();
  const st = load();
  st.opens = st.opens.filter((o) => now - o.ts < 24 * 3600_000);
  const openPositions = await listPositions().then((r) => r.length).catch(() => 0);
  if (openPositions >= a.maxOpen) return skip(`open positions ${openPositions} ≥ maxOpen ${a.maxOpen}`);
  const lastHour = st.opens.filter((o) => now - o.ts < 3600_000).length;
  if (lastHour >= a.maxPerHour) return skip(`${lastHour} open/hour ≥ maxPerHour ${a.maxPerHour}`);
  const spentToday = st.opens.reduce((s, o) => s + o.sizeEth, 0);
  if (spentToday + a.sizeEth > a.dailyCapEth) return skip(`daily cap: ${spentToday.toFixed(4)}+${a.sizeEth} > ${a.dailyCapEth}Ξ`);

  // 7. Wallet funds
  const b = await balances().catch(() => null);
  if (b) {
    const usable = Number(b.weth) + Math.max(0, Number(b.eth) - GAS_RESERVE);
    if (usable < a.sizeEth) return skip(`balance ${usable.toFixed(5)} < size ${a.sizeEth}`);
    if (Number(b.eth) < GAS_RESERVE) return skip(`native ETH < gas reserve`);
  }

  // 8. Pick pool
  const pools = await findPools(candidate.token).catch(() => []);
  const pool = pickLpPool(pools) || (pools.length > 0 ? pools[0] : null);
  if (!pool) return skip(`no active pool found on DEX`);

  const w = wallet();
  const amountWei = ethers.parseEther(String(a.sizeEth));

  // Ensure WETH wrapped
  const wc = new ethers.Contract(C.weth, [...WETH_ABI, "function deposit() payable"], w);
  const wbal: bigint = await wc.balanceOf!(w.address).catch(() => 0n);
  if (wbal < amountWei) {
    const wrapTx = await wc.deposit!({ value: amountWei - wbal, ...(await overrides()) });
    await wrapTx.wait();
  }

  // 9. EXECUTE DIRECT BUY OR LP
  if (String(a.mode) === "buy" || String(a.mode) === "swap") {
    try {
      log.info(`[REAL MEME BUY] Swapping ${a.sizeEth}Ξ WETH → ${candidate.symbol} (${candidate.token})`);
      const swapRes = await swapWethToToken(candidate.token, amountWei, pool.fee);
      log.info(`[REAL MEME BOUGHT ✅] Received ${candidate.symbol} in wallet! Tx: ${swapRes.tx}`);
      st.opens.push({ ts: now, token: candidate.token, sizeEth: a.sizeEth, txHash: swapRes.tx, mode: "buy" });
      save(st);
      void trackNewMemeBuy(candidate.token, candidate.symbol, a.sizeEth, swapRes.amountOut);
      return { opened: true, reason: "bought_token", token: candidate.token, symbol: candidate.symbol, sizeEth: a.sizeEth, result: swapRes };
    } catch (e) {
      return skip(`buy failed: ${(e as Error).message.slice(0, 100)}`);
    }
  } else {
    try {
      log.info(`AUTO-OPEN ${candidate.symbol} ${a.sizeEth}Ξ ${a.mode} pool fee ${pool.fee}`);
      const result = await openPosition(candidate.token, pool.pool, String(a.sizeEth), { mode: a.mode as MintMode });
      st.opens.push({ ts: now, token: candidate.token, sizeEth: a.sizeEth, tokenId: result.tokenId, mode: a.mode });
      save(st);
      return { opened: true, reason: "opened_lp", token: candidate.token, symbol: candidate.symbol, sizeEth: a.sizeEth, result };
    } catch (e) {
      return skip(`open failed: ${(e as Error).message.slice(0, 100)}`);
    }
  }
}

export function autoLpStatus(): { spentToday: number; opensToday: number; lastHour: number } {
  const now = Date.now();
  const st = load();
  const today = st.opens.filter((o) => now - o.ts < 24 * 3600_000);
  return {
    spentToday: today.reduce((s, o) => s + o.sizeEth, 0),
    opensToday: today.length,
    lastHour: today.filter((o) => now - o.ts < 3600_000).length,
  };
}
