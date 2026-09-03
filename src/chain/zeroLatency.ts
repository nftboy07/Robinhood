/**
 * Zero-Latency Execution & In-Memory Pipeline Engine
 */
import { ethers } from "ethers";
import { provider, cacheGasPrice } from "./client.js";

export { getInstantGasOverrides } from "./client.js";

const ALLOWANCE_CACHE = new Set<string>();
const WETH_ROUTER_APPROVED = { ok: false };

/** Continuously pre-warm gas prices every 1.5s in memory */
export function startGasPrewarmer(): void {
  const refresh = async () => {
    try {
      const fee = await provider.getFeeData();
      if (fee.gasPrice) cacheGasPrice(fee.gasPrice * 3n);
    } catch {
      /* keep previous */
    }
  };
  void refresh();
  setInterval(() => void refresh(), 1500);
}

export function isTokenPreApprovedFast(tokenAddr: string): boolean {
  return ALLOWANCE_CACHE.has(tokenAddr.toLowerCase());
}

export function markTokenApprovedFast(tokenAddr: string): void {
  ALLOWANCE_CACHE.add(tokenAddr.toLowerCase());
}

export function isWethRouterApprovedFast(): boolean {
  return WETH_ROUTER_APPROVED.ok;
}

export function markWethRouterApprovedFast(): void {
  WETH_ROUTER_APPROVED.ok = true;
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
