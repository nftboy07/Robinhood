/**
 * Zero-Latency (0ms) Execution & In-Memory Pipeline Engine
 */
import { ethers } from "ethers";
import { provider } from "./client.js";

// In-Memory Global Caches (0ms retrieval)
const ALLOWANCE_CACHE = new Set<string>();
let CACHED_GAS_PRICE: bigint = 1_000_000_000n;

/** Continuously pre-warm gas prices every 1.5s in memory */
export function startGasPrewarmer(): void {
  setInterval(async () => {
    try {
      const fee = await provider.getFeeData();
      if (fee.gasPrice) {
        CACHED_GAS_PRICE = fee.gasPrice * 2n;
      }
    } catch {
      /* keep previous cached gas */
    }
  }, 1500);
}

/** Get instant 0ms pre-warmed gas overrides */
export function getInstantGasOverrides(): ethers.Overrides {
  return { gasPrice: CACHED_GAS_PRICE };
}

/** Check if token is already known to be approved in 0ms */
export function isTokenPreApprovedFast(tokenAddr: string): boolean {
  return ALLOWANCE_CACHE.has(tokenAddr.toLowerCase());
}

/** Record token as approved in local memory */
export function markTokenApprovedFast(tokenAddr: string): void {
  ALLOWANCE_CACHE.add(tokenAddr.toLowerCase());
}

const ROUTER_IFACE = new ethers.Interface([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
]);

export function buildFastSwapCalldata(params: {
  tokenIn: string;
  tokenOut: string;
  fee: number;
  recipient: string;
  amountIn: bigint;
  amountOutMinimum: bigint;
}): string {
  return ROUTER_IFACE.encodeFunctionData("exactInputSingle", [
    {
      tokenIn: params.tokenIn,
      tokenOut: params.tokenOut,
      fee: params.fee,
      recipient: params.recipient,
      amountIn: params.amountIn,
      amountOutMinimum: params.amountOutMinimum,
      sqrtPriceLimitX96: 0n,
    },
  ]);
}
