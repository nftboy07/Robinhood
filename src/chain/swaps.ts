/**
 * Quotes + swaps with 0ms pre-approval and atomic nonce management.
 */
import { ethers } from "ethers";
import { withTxLock } from "./txMutex.js";
import { isTokenPreApprovedFast, markTokenApprovedFast } from "./zeroLatency.js";
import { cfg, C } from "../config.js";
import { wallet, provider, overrides } from "./client.js";
import { ERC20_ABI, WETH_ABI, QUOTER_ABI, ROUTER_ABI } from "./abis.js";
import { logger } from "../util/log.js";
import type { TopUp } from "../types.js";

const log = logger("swap");

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

/** Best token→WETH quote across all fee tiers. { weth: 0 } means no liquidity (rug). */
export async function quoteTokenToWeth(tokenAddr: string, amountRaw: bigint): Promise<Quote> {
  if (amountRaw <= 0n) return { weth: 0, fee: 0, amountOut: 0n };
  const q = new ethers.Contract(C.quoter, QUOTER_ABI, wallet());
  let best: Quote = { weth: 0, fee: 0, amountOut: 0n };
  for (const fee of cfg.lp.feeTiers) {
    try {
      const r = await q.quoteExactInputSingle!.staticCall({
        tokenIn: tokenAddr,
        tokenOut: C.weth,
        amountIn: amountRaw,
        fee,
        sqrtPriceLimitX96: 0n,
      });
      const out = r[0] as bigint;
      const weth = Number(ethers.formatEther(out));
      if (weth > best.weth) best = { weth, fee, amountOut: out };
    } catch {
      /* pool for this fee tier doesn't exist */
    }
  }
  return best;
}

/** Best WETH→token quote across all fee tiers. */
export async function quoteWethToToken(
  tokenAddr: string,
  wethRaw: bigint,
  feeHint?: number,
): Promise<{ amountOut: bigint; fee: number }> {
  const q = new ethers.Contract(C.quoter, QUOTER_ABI, wallet());
  const tiers = feeHint ? [feeHint] : cfg.lp.feeTiers;
  let best = { amountOut: 0n, fee: feeHint ?? 0 };
  for (const fee of tiers) {
    try {
      const r = await q.quoteExactInputSingle!.staticCall({
        tokenIn: C.weth,
        tokenOut: tokenAddr,
        amountIn: wethRaw,
        fee,
        sqrtPriceLimitX96: 0n,
      });
      const out = r[0] as bigint;
      if (out > best.amountOut) best = { amountOut: out, fee };
    } catch {
      /* no pool this tier */
    }
  }
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

/** Swap token → WETH with slippage protection and 0ms pre-approval. */
export async function swapTokenToWeth(
  tokenAddr: string,
  amountRaw: bigint,
  feeHint?: number,
): Promise<SwapResult> {
  return withTxLock(async (nonce) => {
    const w = wallet();
    const erc = new ethers.Contract(tokenAddr, ERC20_ABI, w);
    if (!isTokenPreApprovedFast(tokenAddr)) {
      if ((await erc.allowance!(w.address, C.swapRouter02)) < amountRaw) {
        await (await erc.approve!(C.swapRouter02, ethers.MaxUint256, { ...(await overrides()), nonce })).wait();
      }
      markTokenApprovedFast(tokenAddr);
    }
    const quote = await quoteTokenToWeth(tokenAddr, amountRaw);
    const fee = feeHint || quote.fee || 10000;
    const minOut = minOutWithSlippage(quote.amountOut);
    const router = new ethers.Contract(C.swapRouter02, ROUTER_ABI, w);
    const txOverrides = await overrides();
    const tx = await router.exactInputSingle!(
      {
        tokenIn: tokenAddr,
        tokenOut: C.weth,
        fee,
        recipient: w.address,
        amountIn: amountRaw,
        amountOutMinimum: minOut,
        sqrtPriceLimitX96: 0n,
      },
      txOverrides,
    );
    try {
      const rc = await tx.wait();
      return { tx: tx.hash, amountOut: extractWethOut(rc, w.address) ?? quote.amountOut };
    } catch (err) {
      log.warn(`[SELL SLIPPAGE RETRY] Initial sell reverted, retrying with 15% slippage floor...`);
      const relaxedMinOut = minOutWithSlippage(quote.amountOut, 15);
      const retryTx = await router.exactInputSingle!(
        {
          tokenIn: tokenAddr,
          tokenOut: C.weth,
          fee,
          recipient: w.address,
          amountIn: amountRaw,
          amountOutMinimum: relaxedMinOut,
          sqrtPriceLimitX96: 0n,
        },
        await overrides(),
      );
      const rc2 = await retryTx.wait();
      return { tx: retryTx.hash, amountOut: extractWethOut(rc2, w.address) ?? quote.amountOut };
    }
  });
}

/** Swap WETH → token with slippage protection. */
export async function swapWethToToken(
  tokenAddr: string,
  wethRaw: bigint,
  fee: number,
): Promise<SwapResult> {
  return withTxLock(async (nonce) => {
    const w = wallet();
    const wc = new ethers.Contract(C.weth, WETH_ABI, w);
    if ((await wc.allowance!(w.address, C.swapRouter02)) < wethRaw) {
      await (await wc.approve!(C.swapRouter02, ethers.MaxUint256, { ...(await overrides()), nonce })).wait();
    }
    const quote = await quoteWethToToken(tokenAddr, wethRaw, fee);
    const minOut = minOutWithSlippage(quote.amountOut);
    const erc = new ethers.Contract(tokenAddr, ERC20_ABI, provider);
    const before: bigint = await erc.balanceOf!(w.address);
    const router = new ethers.Contract(C.swapRouter02, ROUTER_ABI, w);
    const txOverrides = { ...(await overrides()), nonce };
    const tx = await router.exactInputSingle!(
      {
        tokenIn: C.weth,
        tokenOut: tokenAddr,
        fee: fee > 0 ? fee : 10000,
        recipient: w.address,
        amountIn: wethRaw,
        amountOutMinimum: minOut,
        sqrtPriceLimitX96: 0n,
      },
      txOverrides,
    );
    await tx.wait();
    const after: bigint = await erc.balanceOf!(w.address);
    return { tx: tx.hash, amountOut: after - before };
  });
}

/** Pre-approve token for SwapRouter02 immediately upon purchase to enable 0ms instant exit */
export async function preApproveTokenForExit(tokenAddr: string): Promise<boolean> {
  try {
    if (isTokenPreApprovedFast(tokenAddr)) return true;
    const w = wallet();
    const erc = new ethers.Contract(tokenAddr, ERC20_ABI, w);
    const allowance: bigint = await erc.allowance!(w.address, C.swapRouter02).catch(() => 0n);
    if (allowance < ethers.MaxUint256 / 2n) {
      log.info(`⚡ [INSTANT PRE-APPROVAL] Pre-approving token ${tokenAddr} for SwapRouter02...`);
      return withTxLock(async (nonce) => {
        const tx = await erc.approve!(C.swapRouter02, ethers.MaxUint256, { ...(await overrides()), nonce });
        await tx.wait();
        markTokenApprovedFast(tokenAddr);
        log.info(`⚡ [PRE-APPROVAL COMPLETE ✅] ${tokenAddr} pre-approved for 0ms instant sell exits! (Tx: ${tx.hash})`);
        return true;
      });
    }
    markTokenApprovedFast(tokenAddr);
    return true;
  } catch (e) {
    log.warn(`[PRE-APPROVE ERROR] Failed to pre-approve ${tokenAddr}: ${(e as Error).message}`);
    return false;
  }
}

/** Sum of WETH Transfer events into `to` in a receipt (real swap output). */
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
