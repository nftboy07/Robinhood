/**
 * Generate randomized, non-uniform tranche amounts totaling targetSizeEth (Anti-MEV stealth sizing)
 */
export function generateRandomizedTranches(totalEth: number): number[] {
  const r1 = 0.28 + Math.random() * 0.07;
  const r2 = 0.18 + Math.random() * 0.07;
  const t1 = Math.max(0.001, Number((totalEth * r1).toFixed(5)));
  const t2 = Math.max(0.001, Number((totalEth * r2).toFixed(5)));
  const t3 = Math.max(0.001, Number((totalEth - t1 - t2).toFixed(5)));
  return [t1, t2, t3];
}

import { ethers } from "ethers";
import { cfg, C } from "../config.js";
import { findPools, pickLpPool } from "../chain/pools.js";
import { openPosition } from "../chain/positions.js";
import {
  swapWethToTokenMultiFire,
  preApproveTokenForExit,
  rememberPoolFee,
  tokenBalanceRaw,
} from "../chain/swaps.js";
import { balances } from "../chain/holdings.js";
import { wallet, overrides } from "../chain/client.js";
import { WETH_ABI } from "../chain/abis.js";
import { trackNewMemeBuy, countOpenMemePositions } from "./strategy.js";
import { isBlacklisted, addToBlacklist } from "./blacklist.js";
import { auditTokenSecurity } from "../tools/cryptoTools.js";
import { dataPath, readJson, writeJson } from "../util/files.js";
import { logger } from "../util/log.js";
import type { Candidate, Verdict } from "./radar.js";
import type { OpenResult, MintMode } from "../types.js";

const log = logger("autolp");
const STATE_FILE = dataPath("autolp-state.json");
const GAS_RESERVE = 0.005;

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

let stateMem: State | null = null;
const load = (): State => {
  if (!stateMem) stateMem = readJson<State>(STATE_FILE, { opens: [] });
  return stateMem;
};
const save = (s: State): void => {
  stateMem = s;
  writeJson(STATE_FILE, s);
};

/** Multi-fire randomized tranches — consecutive nonces, no receipt waits between. */
async function executeSplitSnipe(
  candidate: Candidate,
  totalTargetEth: number,
  fee: number,
): Promise<{ tx: string; totalTokens: bigint; totalSpentEth: number }> {
  const tranches = generateRandomizedTranches(totalTargetEth);
  const w = wallet();
  const wc = new ethers.Contract(C.weth, [...WETH_ABI, "function deposit() payable"], w);
  const totalWei = ethers.parseEther(totalTargetEth.toFixed(6));

  log.info(
    `🎯 [SPLIT SNIPE] Multi-fire ${tranches.map((t) => t.toFixed(4)).join(" / ")}Ξ → ${candidate.symbol} fee=${fee}`,
  );

  // One wrap for full size up front
  const wbal: bigint = await wc.balanceOf!(w.address).catch(() => 0n);
  if (wbal < totalWei) {
    const wrapTx = await wc.deposit!({ value: totalWei - wbal, ...(await overrides()) });
    // Don't block forever — short wait for wrap only
    await wrapTx.wait();
  }

  const amounts = tranches.map((t) => ethers.parseEther(t.toFixed(6)));
  const before = await tokenBalanceRaw(candidate.token);
  const fired = await swapWethToTokenMultiFire(candidate.token, amounts, fee);

  // Best-effort balance delta (async settle)
  await new Promise((r) => setTimeout(r, 1200));
  const after = await tokenBalanceRaw(candidate.token);
  const got = after > before ? after - before : 0n;

  return {
    tx: fired.tx,
    totalTokens: got,
    totalSpentEth: tranches.reduce((s, t) => s + t, 0),
  };
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

  if (isBlacklisted(candidate.token)) return skip("blacklisted honeypot/scam token");
  if (!a.sources.includes(candidate.source)) return skip(`source ${candidate.source} not allowed`);

  const g = verdict?.gmgn ?? null;
  const mcap = (g as any)?.marketCap ?? candidate.fdv ?? 0;
  if (a.maxMcapUsd > 0 && mcap > 0 && mcap > a.maxMcapUsd) {
    return skip(`market cap $${mcap.toFixed(0)} > $${a.maxMcapUsd}`);
  }

  const isFastSource =
    candidate.source === "feed-new" ||
    candidate.source === "noxa-curve" ||
    candidate.source === "poke-ai";
  const isMicroCap = (mcap > 0 && mcap < 100_000) || isFastSource;
  const hasBuyPressure = (candidate.vol5m ?? 0) > 0 || (candidate.onchainBackPct ?? 100) >= 90;

  if (isMicroCap && hasBuyPressure) {
    log.info(`⚡ [FAST PATH] ${candidate.symbol} source=${candidate.source}`);
  } else if (a.requireLlm) {
    if (!verdict?.llm) return skip("no LLM verdict");
    if (verdict.llm.action !== a.requireAction && verdict.llm.action !== "ape") {
      return skip(`action ${verdict.llm.action} ≠ ${a.requireAction}`);
    }
    if (verdict.llm.score < a.minScore) return skip(`score ${verdict.llm.score} < ${a.minScore}`);
  }

  // Defer GoPlus on fast sniper sources — fire first, audit async (blacklist later)
  if (!isFastSource) {
    const security = await auditTokenSecurity(candidate.token);
    if (security.isHoneypot || security.securityScore < 50) {
      addToBlacklist(candidate.token, candidate.symbol, security.warnings.join("; ") || "Failed GoPlus");
      return skip(`security scan failed (Score: ${security.securityScore}/100)`);
    }
  } else {
    void auditTokenSecurity(candidate.token).then((security) => {
      if (security.isHoneypot || security.securityScore < 50) {
        addToBlacklist(candidate.token, candidate.symbol, security.warnings.join("; ") || "Failed GoPlus");
      }
    }).catch(() => {});
  }

  if (a.requireGmgn && !g) return skip("GMGN required but not available");
  if (g) {
    if (g.isHoneypot === "yes" || (g.isHoneypot as unknown) === true) {
      addToBlacklist(candidate.token, candidate.symbol, "GMGN honeypot flag");
      return skip("GMGN honeypot");
    }
    const tax = Math.max((g.buyTax ?? 0) * 100, (g.sellTax ?? 0) * 100);
    if (tax > a.maxTaxPct) return skip(`tax ${tax.toFixed(1)}% > ${a.maxTaxPct}%`);
  }

  const liq = g?.liquidityUsd ?? candidate.liq ?? 0;
  if (a.minLiqUsd > 0 && liq > 0 && liq < a.minLiqUsd) return skip(`liquidity $${liq.toFixed(0)} < $${a.minLiqUsd}`);

  const targetSizeEth = 0.01;
  const now = Date.now();
  const st = load();
  st.opens = st.opens.filter((o) => now - o.ts < 24 * 3600_000);

  // Cheap open count — meme positions + recent autolp opens (NOT full listPositions)
  const memeOpen = countOpenMemePositions();
  const openPositions = Math.max(memeOpen, st.opens.filter((o) => now - o.ts < 6 * 3600_000).length);
  if (openPositions >= a.maxOpen) return skip(`open positions ${openPositions} ≥ maxOpen ${a.maxOpen}`);

  const lastHour = st.opens.filter((o) => now - o.ts < 3600_000).length;
  if (lastHour >= a.maxPerHour) return skip(`${lastHour} open/hour ≥ maxPerHour ${a.maxPerHour}`);
  const spentToday = st.opens.reduce((s, o) => s + o.sizeEth, 0);
  if (spentToday + targetSizeEth > a.dailyCapEth) {
    return skip(`daily cap: ${spentToday.toFixed(4)}+${targetSizeEth} > ${a.dailyCapEth}Ξ`);
  }

  const b = await balances().catch(() => null);
  if (b) {
    const usable = Number(b.weth) + Math.max(0, Number(b.eth) - GAS_RESERVE);
    if (usable < 0.003) return skip(`balance ${usable.toFixed(5)} < minimum tranche 0.003Ξ`);
    if (Number(b.eth) < GAS_RESERVE) return skip(`native ETH < gas reserve`);
  }

  // Prefer candidate.fee from event; else discover pools in parallel
  let fee = candidate.fee && candidate.fee > 0 ? candidate.fee : 0;
  let pool = null as Awaited<ReturnType<typeof findPools>>[0] | null;
  if (fee > 0) {
    rememberPoolFee(candidate.token, fee);
  } else {
    const pools = await findPools(candidate.token).catch(() => []);
    pool = pickLpPool(pools) || (pools.length > 0 ? pools[0]! : null);
    if (!pool) return skip(`no active pool found on DEX`);
    fee = pool.fee;
  }

  if (String(a.mode) === "buy" || String(a.mode) === "swap") {
    try {
      const splitRes = await executeSplitSnipe(candidate, targetSizeEth, fee);
      if (!splitRes.tx) return skip("no txs broadcast");

      st.opens.push({
        ts: now,
        token: candidate.token,
        sizeEth: splitRes.totalSpentEth,
        txHash: splitRes.tx,
        mode: "buy",
      });
      save(st);
      void trackNewMemeBuy(candidate.token, candidate.symbol, splitRes.totalSpentEth, splitRes.totalTokens);
      void preApproveTokenForExit(candidate.token);
      return {
        opened: true,
        reason: "bought_token_split_ladder_multifire",
        token: candidate.token,
        symbol: candidate.symbol,
        sizeEth: splitRes.totalSpentEth,
        result: splitRes,
      };
    } catch (e) {
      return skip(`split buy failed: ${(e as Error).message.slice(0, 100)}`);
    }
  }

  try {
    if (!pool) {
      const pools = await findPools(candidate.token).catch(() => []);
      pool = pickLpPool(pools) || (pools.length > 0 ? pools[0]! : null);
      if (!pool) return skip(`no active pool found on DEX`);
    }
    log.info(`AUTO-OPEN ${candidate.symbol} ${targetSizeEth}Ξ ${a.mode} pool fee ${pool.fee}`);
    const result = await openPosition(candidate.token, pool.pool, String(targetSizeEth), {
      mode: a.mode as MintMode,
    });
    st.opens.push({
      ts: now,
      token: candidate.token,
      sizeEth: targetSizeEth,
      tokenId: result.tokenId,
      mode: a.mode,
    });
    save(st);
    return {
      opened: true,
      reason: "opened_lp",
      token: candidate.token,
      symbol: candidate.symbol,
      sizeEth: targetSizeEth,
      result,
    };
  } catch (e) {
    return skip(`open failed: ${(e as Error).message.slice(0, 100)}`);
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
