/**
 * Detect NEW WETH pool creation / first liquidity / meme token launch from feed transactions.
 *
 * Supported Launchpads & Factories:
 *   - Uniswap V3 / V4 Position Manager & Factories
 *   - Noxa Fun Bonding Curve Launchpad (fun.noxa.fi)
 *   - O1 Exchange Launchpads (v1, v2, v3)
 *   - ZeroHood / Hood.fun Launchpad
 *   - FOMO.fund Launchpad
 *   - GMGN / Flap Launchpads
 */
import { ethers } from "ethers";
import { C } from "../config.js";
import type { FeedTx } from "./decode.js";

const NPM_L = C.positionManager.toLowerCase();
const FACTORY_L = C.factory.toLowerCase();
const V2_FACTORY_L = (C.v2Factory || "0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f").toLowerCase();
const WETH_L = C.weth.toLowerCase();

// Known Launchpad Contracts
const KNOWN_LAUNCHPADS = new Set([
  NPM_L,
  FACTORY_L,
  V2_FACTORY_L,
  "0x8b40fc20c405d47d725c9723d056a1c6f62bbccf", // O1 v1
  "0x76f0923ac4df0a079a10f628a7bce6426ccd344a", // O1 v2
  "0x411f21283d3e492bc395027329e08f9f4f560ba5", // O1 v3
  "0x694b6c5299a0416e0997c62de5503a00a82a48f3", // Hood.fun
  "0xcaf681a66d020601342297493863e78c959e5cb2", // FOMO.fund / SwapRouter
]);

const IFACE = new ethers.Interface([
  "function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline))",
  "function createAndInitializePoolIfNecessary(address token0,address token1,uint24 fee,uint160 sqrtPriceX96)",
  "function createPool(address tokenA,address tokenB,uint24 fee)",
  "function createPair(address tokenA,address tokenB)",
  "function launchToken(string name, string symbol, uint256 totalSupply)",
  "function createToken(string name, string symbol, uint256 initialSupply)",
  "function multicall(bytes[] data)",
  "function multicall(uint256 deadline, bytes[] data)",
  "function multicall(bytes32 previousBlockhash, bytes[] data)",
]);

export interface PoolEvent {
  hash: string;
  from: string | null;
  token: string;
  fee: number;
  wethSeed: bigint;
  kind: "mint" | "create";
}

/** Extract pool creation / mint / launch events from a feed tx. */
export function extractPoolEvents(ftx: FeedTx): PoolEvent[] {
  const to = ftx.tx.to?.toLowerCase();
  if (!to || (!KNOWN_LAUNCHPADS.has(to) && !isContractTarget(to)) || !ftx.tx.data || ftx.tx.data === "0x") return [];
  const out: PoolEvent[] = [];
  decode(ftx.tx.data, ftx.tx.hash ?? "", ftx.tx.from, out);
  return out;
}

function isContractTarget(to: string): boolean {
  return to === NPM_L || to === FACTORY_L || to === V2_FACTORY_L;
}

function decode(data: string, hash: string, from: string | null, out: PoolEvent[]): void {
  let parsed;
  try {
    parsed = IFACE.parseTransaction({ data });
  } catch {
    return;
  }
  if (!parsed) return;

  if (parsed.name === "multicall") {
    for (const c of parsed.args[parsed.args.length - 1] as string[]) decode(c, hash, from, out);
    return;
  }

  if (parsed.name === "mint") {
    const p = parsed.args[0];
    const t0 = String(p.token0).toLowerCase();
    const t1 = String(p.token1).toLowerCase();
    const info = wethPair(t0, t1);
    if (!info) return;
    const wethSeed = info.wethIsToken0 ? (p.amount0Desired as bigint) : (p.amount1Desired as bigint);
    out.push({ hash, from, token: info.token, fee: Number(p.fee), wethSeed, kind: "mint" });
    return;
  }

  if (parsed.name === "createAndInitializePoolIfNecessary" || parsed.name === "createPool" || parsed.name === "createPair") {
    const t0 = String(parsed.args[0]).toLowerCase();
    const t1 = String(parsed.args[1]).toLowerCase();
    const info = wethPair(t0, t1);
    const fee = parsed.args[2] ? Number(parsed.args[2]) : 3000;
    if (info) out.push({ hash, from, token: info.token, fee, wethSeed: 0n, kind: "create" });
  }
}

function wethPair(t0: string, t1: string): { token: string; wethIsToken0: boolean } | null {
  if (t0 === WETH_L) return { token: t1, wethIsToken0: true };
  if (t1 === WETH_L) return { token: t0, wethIsToken0: false };
  return null;
}
