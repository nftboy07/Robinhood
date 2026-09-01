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

/** Execute 3-Tranche Split Ladder Snipe (0.003Ξ -> 0.002Ξ -> 0.005Ξ) to reduce entry price */
async function executeSplitSnipe(
  candidate: Candidate,
  totalTargetEth: number,
  fee: number,
): Promise<{ tx: string; totalTokens: bigint; totalSpentEth: number }> {
  // 3-Tranche Split: 0.003 -> 0.002 -> 0.005 (or proportionally if different size)
  const ratio = totalTargetEth / 0.010;
  const tranches = [
    Math.max(0.001, 0.003 * ratio),
    Math.max(0.001, 0.002 * ratio),
    Math.max(0.001, 0.005 * ratio),
  ];

  let cumulativeTokens = 0n;
  let cumulativeSpent = 0;
  let firstTx = "";

  const w = wallet();
  const wc = new ethers.Contract(C.weth, [...WETH_ABI, "function deposit() payable"], w);

  log.info(`🎯 [SPLIT SNIPE LADDER] Executing 3-Tranche Entry on ${candidate.symbol} (${tranches[0].toFixed(3)}Ξ ➔ ${tranches[1].toFixed(3)}Ξ ➔ ${tranches[2].toFixed(3)}Ξ) to minimize slippage & lower entry price`);

  for (let i = 0; i < tranches.length; i++) {
    const trancheEth = tranches[i];
    const trancheWei = ethers.parseEther(trancheEth.toFixed(6));

    // Ensure WETH
    const wbal: bigint = await wc.balanceOf!(w.address).catch(() => 0n);
    if (wbal < trancheWei) {
      const wrapTx = await wc.deposit!({ value: trancheWei - wbal, ...(await overrides()) });
      await wrapTx.wait();
    }

    try {
      log.info(`⚡ [TRANCHE ${i + 1}/3] Swapping ${trancheEth.toFixed(3)}Ξ WETH → ${candidate.symbol}...`);
      const res = await swapWethToToken(candidate.token, trancheWei, fee);
      if (!firstTx) firstTx = res.tx;
      cumulativeTokens += res.amountOut;
      cumulativeSpent += trancheEth;
      log.info(`✅ [TRANCHE ${i + 1}/3 BOUGHT] +${res.amountOut.toString()} ${candidate.symbol} (Tx: ${res.tx})`);

      // Micro-pause between tranches to let pool settle and get better prices
      if (i < tranches.length - 1) {
        await new Promise((r) => setTimeout(r, 6_000));
      }
    } catch (e) {
      log.warn(`⚠️ [TRANCHE ${i + 1} SKIPPED] Error: ${(e as Error).message.slice(0, 80)}`);
      break;
    }
  }

  return { tx: firstTx, totalTokens: cumulativeTokens, totalSpentEth: cumulativeSpent };
}

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

  // Base Target Size: 0.010 ETH
  const targetSizeEth = 0.010;

  // 6. Caps
  const now = Date.now();
  const st = load();
  st.opens = st.opens.filter((o) => now - o.ts < 24 * 3600_000);
  const openPositions = await listPositions().then((r) => r.length).catch(() => 0);
  if (openPositions >= a.maxOpen) return skip(`open positions ${openPositions} ≥ maxOpen ${a.maxOpen}`);
  const lastHour = st.opens.filter((o) => now - o.ts < 3600_000).length;
  if (lastHour >= a.maxPerHour) return skip(`${lastHour} open/hour ≥ maxPerHour ${a.maxPerHour}`);
  const spentToday = st.opens.reduce((s, o) => s + o.sizeEth, 0);
  if (spentToday + targetSizeEth > a.dailyCapEth) return skip(`daily cap: ${spentToday.toFixed(4)}+${targetSizeEth} > ${a.dailyCapEth}Ξ`);

  // 7. Wallet funds check
  const b = await balances().catch(() => null);
  if (b) {
    const usable = Number(b.weth) + Math.max(0, Number(b.eth) - GAS_RESERVE);
    if (usable < 0.003) return skip(`balance ${usable.toFixed(5)} < minimum tranche 0.003Ξ`);
    if (Number(b.eth) < GAS_RESERVE) return skip(`native ETH < gas reserve`);
  }

  // 8. Pick pool
  const pools = await findPools(candidate.token).catch(() => []);
  const pool = pickLpPool(pools) || (pools.length > 0 ? pools[0] : null);
  if (!pool) return skip(`no active pool found on DEX`);

  // 9. EXECUTE 3-TRANCHE SPLIT BUY OR LP
  if (String(a.mode) === "buy" || String(a.mode) === "swap") {
    try {
      const splitRes = await executeSplitSnipe(candidate, targetSizeEth, pool.fee);
      if (splitRes.totalTokens <= 0n) return skip("no tokens received across tranches");

      st.opens.push({ ts: now, token: candidate.token, sizeEth: splitRes.totalSpentEth, txHash: splitRes.tx, mode: "buy" });
      save(st);
      void trackNewMemeBuy(candidate.token, candidate.symbol, splitRes.totalSpentEth, splitRes.totalTokens);
      return { opened: true, reason: "bought_token_split_ladder", token: candidate.token, symbol: candidate.symbol, sizeEth: splitRes.totalSpentEth, result: splitRes };
    } catch (e) {
      return skip(`split buy failed: ${(e as Error).message.slice(0, 100)}`);
    }
  } else {
    try {
      log.info(`AUTO-OPEN ${candidate.symbol} ${targetSizeEth}Ξ ${a.mode} pool fee ${pool.fee}`);
      const result = await openPosition(candidate.token, pool.pool, String(targetSizeEth), { mode: a.mode as MintMode });
      st.opens.push({ ts: now, token: candidate.token, sizeEth: targetSizeEth, tokenId: result.tokenId, mode: a.mode });
      save(st);
      return { opened: true, reason: "opened_lp", token: candidate.token, symbol: candidate.symbol, sizeEth: targetSizeEth, result };
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
