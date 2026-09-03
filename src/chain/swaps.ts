/**
 * Quotes + swaps with cached approvals, fire-and-forget broadcast, and panic exits.
 * Receipt waits happen OUTSIDE the tx mutex so emergency sells are not blocked.
 */
import { ethers } from "ethers";
import { withTxLock } from "./txMutex.js";
import {
  isTokenPreApprovedFast,
  markTokenApprovedFast,
  isWethRouterApprovedFast,
  markWethRouterApprovedFast,
  buildFastSwapCalldata,
  getInstantGasOverrides,
} from "./zeroLatency.js";
import { cfg, C } from "../config.js";
import { wallet, provider, overrides } from "./client.js";
import { ERC20_ABI, WETH_ABI, QUOTER_ABI } from "./abis.js";
import { logger } from "../util/log.js";
import type { TopUp } from "../types.js";

const log = logger("swap");

const FEE_CACHE = new Map<string, number>(); // tokenLower → best fee

export function rememberPoolFee(tokenAddr: string, fee: number): void {
  if (fee > 0) FEE_CACHE.set(tokenAddr.toLowerCase(), fee);
}

export function cachedPoolFee(tokenAddr: string): number | undefined {
  return FEE_CACHE.get(tokenAddr.toLowerCase());
}

/** Raw token balance (BigInt) of the bot wallet. */
export async function tokenBalanceRaw(tokenAddr: string): Promise<bigint> {
  try {
    return await new ethers.Contract(tokenAddr, ERC20_ABI, provider).balanceOf!(wallet().address);
  } catch {
    return 0n;
  }
}

export interface Quote {
  weth: number;
  fee: number;
  amountOut: bigint;
}

/** Best token→WETH quote across all fee tiers (parallel). */
export async function quoteTokenToWeth(tokenAddr: string, amountRaw: bigint): Promise<Quote> {
  if (amountRaw <= 0n) return { weth: 0, fee: 0, amountOut: 0n };
  const q = new ethers.Contract(C.quoter, QUOTER_ABI, provider);
  const hint = cachedPoolFee(tokenAddr);
  const tiers = hint ? [hint, ...cfg.lp.feeTiers.filter((f) => f !== hint)] : cfg.lp.feeTiers;

  const results = await Promise.all(
    tiers.map(async (fee) => {
      try {
        const r = await q.quoteExactInputSingle!.staticCall({
          tokenIn: tokenAddr,
          tokenOut: C.weth,
          amountIn: amountRaw,
          fee,
          sqrtPriceLimitX96: 0n,
        });
        const out = r[0] as bigint;
        return { weth: Number(ethers.formatEther(out)), fee, amountOut: out };
      } catch {
        return { weth: 0, fee, amountOut: 0n };
      }
    }),
  );

  let best: Quote = { weth: 0, fee: 0, amountOut: 0n };
  for (const r of results) {
    if (r.weth > best.weth) best = r;
  }
  if (best.fee > 0) rememberPoolFee(tokenAddr, best.fee);
  return best;
}

/** Best WETH→token quote across fee tiers (parallel). */
export async function quoteWethToToken(
  tokenAddr: string,
  wethRaw: bigint,
  feeHint?: number,
): Promise<{ amountOut: bigint; fee: number }> {
  const q = new ethers.Contract(C.quoter, QUOTER_ABI, provider);
  const tiers = feeHint ? [feeHint] : cfg.lp.feeTiers;
  const results = await Promise.all(
    tiers.map(async (fee) => {
      try {
        const r = await q.quoteExactInputSingle!.staticCall({
          tokenIn: C.weth,
          tokenOut: tokenAddr,
          amountIn: wethRaw,
          fee,
          sqrtPriceLimitX96: 0n,
        });
        return { amountOut: r[0] as bigint, fee };
      } catch {
        return { amountOut: 0n, fee };
      }
    }),
  );
  let best = { amountOut: 0n, fee: feeHint ?? 0 };
  for (const r of results) {
    if (r.amountOut > best.amountOut) best = r;
  }
  if (best.fee > 0) rememberPoolFee(tokenAddr, best.fee);
  return best;
}

function minOutWithSlippage(amountOut: bigint, customSlippagePct?: number): bigint {
  const pct = customSlippagePct ?? cfg.lp.slippagePct ?? 8;
  const bps = BigInt(Math.round(pct * 100));
  return (amountOut * (10_000n - bps)) / 10_000n;
}

export interface SwapResult {
  tx: string;
  amountOut: bigint;
}

async function sendExactInput(params: {
  tokenIn: string;
  tokenOut: string;
  fee: number;
  amountIn: bigint;
  amountOutMinimum: bigint;
  nonce: number;
  gasBoost?: bigint;
}): Promise<ethers.TransactionResponse> {
  const w = wallet();
  const gas = getInstantGasOverrides();
  const gasPrice = ((gas.gasPrice as bigint) || 1_000_000_000n) * (params.gasBoost ?? 1n);
  const data = buildFastSwapCalldata({
    tokenIn: params.tokenIn,
    tokenOut: params.tokenOut,
    fee: params.fee,
    recipient: w.address,
    amountIn: params.amountIn,
    amountOutMinimum: params.amountOutMinimum,
  });
  return w.sendTransaction({
    to: C.swapRouter02,
    data,
    nonce: params.nonce,
    gasPrice,
    gasLimit: (gas.gasLimit as bigint) || 350_000n,
  });
}

/**
 * Panic / whale-exit sell: no quote round-trip, mutex only for broadcast.
 * Uses cached fee or default 10000; amountOutMinimum = 0 for speed.
 */
export async function swapTokenToWethFast(
  tokenAddr: string,
  amountRaw: bigint,
  feeHint?: number,
): Promise<SwapResult> {
  const fee = feeHint || cachedPoolFee(tokenAddr) || 10000;
  rememberPoolFee(tokenAddr, fee);

  let needApprove = !isTokenPreApprovedFast(tokenAddr);
  if (needApprove) {
    const erc = new ethers.Contract(tokenAddr, ERC20_ABI, provider);
    const allowance: bigint = await erc.allowance!(wallet().address, C.swapRouter02).catch(() => 0n);
    if (allowance >= amountRaw) {
      markTokenApprovedFast(tokenAddr);
      needApprove = false;
    }
  }

  const resp = await withTxLock(async (nonce) => {
    const w = wallet();
    let n = nonce;
    if (needApprove) {
      const erc = new ethers.Contract(tokenAddr, ERC20_ABI, w);
      await erc.approve!(C.swapRouter02, ethers.MaxUint256, {
        ...getInstantGasOverrides(),
        nonce: n,
      });
      markTokenApprovedFast(tokenAddr);
      n += 1;
    }
    return sendExactInput({
      tokenIn: tokenAddr,
      tokenOut: C.weth,
      fee,
      amountIn: amountRaw,
      amountOutMinimum: 0n,
      nonce: n,
    });
  }, needApprove ? 2 : 1);

  log.info(`⚡ [PANIC SELL SENT] ${tokenAddr.slice(0, 10)}… tx=${resp.hash}`);
  return { tx: resp.hash, amountOut: 0n };
}

/** Swap token → WETH. Broadcast under lock; wait for receipt outside. */
export async function swapTokenToWeth(
  tokenAddr: string,
  amountRaw: bigint,
  feeHint?: number,
): Promise<SwapResult> {
  const quote = await quoteTokenToWeth(tokenAddr, amountRaw);
  const fee = feeHint || quote.fee || cachedPoolFee(tokenAddr) || 10000;
  const minOut = minOutWithSlippage(quote.amountOut);

  let needApprove = !isTokenPreApprovedFast(tokenAddr);
  if (needApprove) {
    const erc = new ethers.Contract(tokenAddr, ERC20_ABI, provider);
    const allowance: bigint = await erc.allowance!(wallet().address, C.swapRouter02).catch(() => 0n);
    if (allowance >= amountRaw) {
      markTokenApprovedFast(tokenAddr);
      needApprove = false;
    }
  }

  const resp = await withTxLock(async (nonce) => {
    const w = wallet();
    let n = nonce;
    if (needApprove) {
      const erc = new ethers.Contract(tokenAddr, ERC20_ABI, w);
      await erc.approve!(C.swapRouter02, ethers.MaxUint256, {
        ...getInstantGasOverrides(),
        nonce: n,
      });
      markTokenApprovedFast(tokenAddr);
      n += 1;
    }
    return sendExactInput({
      tokenIn: tokenAddr,
      tokenOut: C.weth,
      fee,
      amountIn: amountRaw,
      amountOutMinimum: minOut > 0n ? minOut : 0n,
      nonce: n,
    });
  }, needApprove ? 2 : 1);

  try {
    const rc = await resp.wait();
    return { tx: resp.hash, amountOut: extractWethOut(rc, wallet().address) ?? quote.amountOut };
  } catch {
    log.warn(`[SELL SLIPPAGE RETRY] Initial sell reverted, retrying with floor minOut=0...`);
    const retry = await withTxLock(async (nonce) =>
      sendExactInput({
        tokenIn: tokenAddr,
        tokenOut: C.weth,
        fee,
        amountIn: amountRaw,
        amountOutMinimum: 0n,
        nonce,
        gasBoost: 2n,
      }),
    );
    const rc2 = await retry.wait();
    return { tx: retry.hash, amountOut: extractWethOut(rc2, wallet().address) ?? quote.amountOut };
  }
}

/** Swap WETH → token. Fire under lock; optional confirm outside. */
export async function swapWethToToken(
  tokenAddr: string,
  wethRaw: bigint,
  fee: number,
  opts?: { waitReceipt?: boolean; minOut?: bigint },
): Promise<SwapResult> {
  const useFee = fee > 0 ? fee : cachedPoolFee(tokenAddr) || 10000;
  rememberPoolFee(tokenAddr, useFee);

  let needApprove = !isWethRouterApprovedFast();
  if (needApprove) {
    const wc = new ethers.Contract(C.weth, WETH_ABI, provider);
    const allowance: bigint = await wc.allowance!(wallet().address, C.swapRouter02).catch(() => 0n);
    if (allowance >= wethRaw) {
      markWethRouterApprovedFast();
      needApprove = false;
    }
  }

  let minOut = opts?.minOut;
  if (minOut === undefined) {
    // Skip quote when caller wants pure speed (minOut=0n); otherwise soft quote
    const quote = await quoteWethToToken(tokenAddr, wethRaw, useFee);
    minOut = minOutWithSlippage(quote.amountOut);
  }

  const resp = await withTxLock(async (nonce) => {
    const w = wallet();
    let n = nonce;
    if (needApprove) {
      const wc = new ethers.Contract(C.weth, WETH_ABI, w);
      await wc.approve!(C.swapRouter02, ethers.MaxUint256, {
        ...getInstantGasOverrides(),
        nonce: n,
      });
      markWethRouterApprovedFast();
      n += 1;
    }
    return sendExactInput({
      tokenIn: C.weth,
      tokenOut: tokenAddr,
      fee: useFee,
      amountIn: wethRaw,
      amountOutMinimum: minOut ?? 0n,
      nonce: n,
    });
  }, needApprove ? 2 : 1);

  if (opts?.waitReceipt === false) {
    return { tx: resp.hash, amountOut: 0n };
  }

  const erc = new ethers.Contract(tokenAddr, ERC20_ABI, provider);
  const before: bigint = await erc.balanceOf!(wallet().address).catch(() => 0n);
  await resp.wait();
  const after: bigint = await erc.balanceOf!(wallet().address).catch(() => before);
  return { tx: resp.hash, amountOut: after > before ? after - before : 0n };
}

/**
 * Fire N consecutive WETH→token swaps with consecutive nonces (no inter-tranche wait).
 * Returns first tx hash immediately after all are broadcast.
 */
export async function swapWethToTokenMultiFire(
  tokenAddr: string,
  amounts: bigint[],
  fee: number,
): Promise<{ tx: string; hashes: string[] }> {
  const useFee = fee > 0 ? fee : 10000;
  rememberPoolFee(tokenAddr, useFee);
  const positive = amounts.filter((a) => a > 0n);
  if (!positive.length) return { tx: "", hashes: [] };

  let needApprove = !isWethRouterApprovedFast();
  if (needApprove) {
    const wc = new ethers.Contract(C.weth, WETH_ABI, provider);
    const allowance: bigint = await wc.allowance!(wallet().address, C.swapRouter02).catch(() => 0n);
    if (allowance >= positive.reduce((s, a) => s + a, 0n)) {
      markWethRouterApprovedFast();
      needApprove = false;
    }
  }

  const spend = (needApprove ? 1 : 0) + positive.length;
  const hashes = await withTxLock(async (nonce) => {
    const w = wallet();
    let n = nonce;
    const out: string[] = [];
    if (needApprove) {
      const wc = new ethers.Contract(C.weth, WETH_ABI, w);
      await wc.approve!(C.swapRouter02, ethers.MaxUint256, {
        ...getInstantGasOverrides(),
        nonce: n,
      });
      markWethRouterApprovedFast();
      n += 1;
    }
    for (const amt of positive) {
      const resp = await sendExactInput({
        tokenIn: C.weth,
        tokenOut: tokenAddr,
        fee: useFee,
        amountIn: amt,
        amountOutMinimum: 0n,
        nonce: n,
      });
      out.push(resp.hash);
      n += 1;
    }
    return out;
  }, spend);

  return { tx: hashes[0] ?? "", hashes };
}

/** Pre-approve token for SwapRouter02 — broadcast only, mark optimistic, confirm async. */
export async function preApproveTokenForExit(tokenAddr: string): Promise<boolean> {
  try {
    if (isTokenPreApprovedFast(tokenAddr)) return true;
    const w = wallet();
    const erc = new ethers.Contract(tokenAddr, ERC20_ABI, w);
    const allowance: bigint = await erc.allowance!(w.address, C.swapRouter02).catch(() => 0n);
    if (allowance < ethers.MaxUint256 / 2n) {
      log.info(`⚡ [INSTANT PRE-APPROVAL] Pre-approving token ${tokenAddr} for SwapRouter02...`);
      const resp = await withTxLock(async (nonce) => {
        return erc.approve!(C.swapRouter02, ethers.MaxUint256, {
          ...getInstantGasOverrides(),
          nonce,
        });
      });
      markTokenApprovedFast(tokenAddr); // optimistic — don't wait
      void resp.wait().then(() => {
        log.info(`⚡ [PRE-APPROVAL COMPLETE ✅] ${tokenAddr} (Tx: ${resp.hash})`);
      }).catch(() => {
        /* allowance probe on next sell */
      });
      return true;
    }
    markTokenApprovedFast(tokenAddr);
    return true;
  } catch (e) {
    log.warn(`[PRE-APPROVE ERROR] Failed to pre-approve ${tokenAddr}: ${(e as Error).message}`);
    return false;
  }
}

function extractWethOut(rc: ethers.TransactionReceipt | null, to: string): bigint | null {
  if (!rc) return null;
  const wethL = C.weth.toLowerCase();
  const toTopic = "0x" + to.toLowerCase().slice(2).padStart(64, "0");
  let sum = 0n;
  for (const lg of rc.logs) {
    if (lg.address.toLowerCase() !== wethL) continue;
    if (lg.topics.length === 3 && lg.topics[2]?.toLowerCase() === toTopic) sum += BigInt(lg.data);
  }
  return sum > 0n ? sum : null;
}

export const DEFAULT_NATIVE_TARGET = 0.015;
export async function ensureNativeEth(targetEth?: number): Promise<TopUp | null> {
  const target = Number(targetEth ?? cfg.lp.nativeTargetEth ?? DEFAULT_NATIVE_TARGET);
  if (!(target > 0)) return null;
  const w = wallet();
  const targetWei = ethers.parseEther(String(target));
  const nativeWei = await provider.getBalance(w.address);
  if (nativeWei >= targetWei) return null;
  const wc = new ethers.Contract(C.weth, WETH_ABI, w);
  const wbalWei: bigint = await wc.balanceOf!(w.address);
  if (wbalWei <= 0n) return null;
  const needWei = targetWei - nativeWei;
  const amtWei = needWei < wbalWei ? needWei : wbalWei;
  if (amtWei < 10_000_000_000_000n) return null;
  const tx = await wc.withdraw!(amtWei, await overrides());
  await tx.wait();
  const f = (v: bigint) => Number(ethers.formatEther(v));
  log.info(`top-up gas: unwrap ${f(amtWei)} WETH → native`);
  return {
    unwrapped: f(amtWei),
    tx: tx.hash,
    nativeBefore: f(nativeWei),
    nativeAfter: f(nativeWei + amtWei),
  };
}
