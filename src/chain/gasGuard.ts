/**
 * Automated Native Gas Guard
 * Ensures the hot wallet always has sufficient native ETH for gas by auto-unwrapping WETH.
 */
import { ethers } from "ethers";
import { provider, wallet, overrides } from "./client.js";
import { C } from "../config.js";
import { WETH_ABI } from "./abis.js";
import { send } from "../telegram/tg.js";
import { logger } from "../util/log.js";

const log = logger("gas-guard");
const MIN_NATIVE_ETH = 0.015; // Minimum native ETH threshold
const TOPUP_AMOUNT_ETH = 0.020; // Amount to unwrap when low

export async function checkAndTopUpGas(): Promise<boolean> {
  try {
    const w = wallet();
    const nativeBal = await provider.getBalance(w.address);
    const nativeEth = Number(ethers.formatEther(nativeBal));

    if (nativeEth < MIN_NATIVE_ETH) {
      const wc = new ethers.Contract(C.weth, WETH_ABI, w);
      const wbal: bigint = await wc.balanceOf!(w.address).catch(() => 0n);
      const topUpWei = ethers.parseEther(String(TOPUP_AMOUNT_ETH));

      if (wbal >= topUpWei) {
        log.info(`⛽ [GAS GUARD] Native ETH low (${nativeEth.toFixed(4)}Ξ < ${MIN_NATIVE_ETH}Ξ). Auto-unwrapping ${TOPUP_AMOUNT_ETH}Ξ WETH...`);
        const tx = await wc.withdraw!(topUpWei, await overrides());
        await tx.wait();
        log.info(`⛽ [GAS TOP-UP SUCCESS ✅] Unwrapped ${TOPUP_AMOUNT_ETH}Ξ WETH → Native ETH (Tx: ${tx.hash})`);
        await send(`⛽ <b>[GAS GUARD AUTO-TOPUP]</b>\n• Unwrapped: <b>+${TOPUP_AMOUNT_ETH}Ξ</b> WETH → Native ETH\n• New Native Balance: <b>${(nativeEth + TOPUP_AMOUNT_ETH).toFixed(4)}Ξ</b>\n• Gas reserve fully restored!`).catch(() => {});
        return true;
      }
    }
  } catch (e) {
    log.warn(`[GAS GUARD] Error checking gas: ${(e as Error).message}`);
  }
  return false;
}

let gasTimer: NodeJS.Timeout | null = null;

export function startGasGuard(): void {
  if (gasTimer) return;
  void checkAndTopUpGas();
  gasTimer = setInterval(() => {
    void checkAndTopUpGas();
  }, 120_000); // Check every 2 minutes
}
