/**
 * Whale Sell Approval Frontrunner — block-poll FALLBACK only.
 * Primary race path is sequencer feed (see FeedMonitor / panicExitToken).
 */
import { provider, wallet } from "../chain/client.js";
import { C } from "../config.js";
import { getHeldTokenKeys, panicExitToken } from "./strategy.js";
import { logger } from "../util/log.js";

const log = logger("approval-frontrunner");

const ROUTERS = new Set([
  C.swapRouter02.toLowerCase(),
  (C.universalRouter || "").toLowerCase(),
  "0xca143ce32fe78f1f7019d7d551a6402fc5350c73".toLowerCase(),
  "0x8876789976decbfcbbbe364623c63652db8c0904".toLowerCase(),
  "0x1f7d7550b1b028f7571e69a784071f0205fd2efa".toLowerCase(),
].filter(Boolean));

const APPROVE_SIG = "0x095ea7b3";

let lastSyncedBlock = 0;
let isPolling = false;
const exiting = new Set<string>();

export async function pollWhaleApprovals(): Promise<void> {
  if (isPolling) return;
  isPolling = true;
  try {
    const tip = await provider.getBlockNumber();
    if (lastSyncedBlock === 0) lastSyncedBlock = tip - 1;
    if (tip <= lastSyncedBlock) return;

    const held = new Set(getHeldTokenKeys().map((k) => k.toLowerCase()));
    if (held.size === 0) {
      lastSyncedBlock = tip;
      return;
    }

    const fromBlock = lastSyncedBlock + 1;
    const toBlock = Math.min(tip, fromBlock + 5); // small gap fill

    for (let b = fromBlock; b <= toBlock; b++) {
      const block = await provider.getBlock(b, true);
      if (!block?.prefetchedTransactions) continue;

      for (const tx of block.prefetchedTransactions) {
        const targetToken = tx.to?.toLowerCase();
        if (!targetToken || !held.has(targetToken)) continue;
        if (!tx.data?.startsWith(APPROVE_SIG)) continue;
        const from = tx.from?.toLowerCase();
        if (from && from === wallet().address.toLowerCase()) continue;

        const spender = ("0x" + tx.data.slice(34, 74)).toLowerCase();
        if (!ROUTERS.has(spender)) continue;
        if (exiting.has(targetToken)) continue;
        exiting.add(targetToken);

        log.warn(`🚨 [BLOCK-FALLBACK APPROVE] ${targetToken} spender=${spender} from=${tx.from}`);
        void panicExitToken(targetToken, `mined-approve from ${tx.from?.slice(0, 10)}`).finally(() => {
          exiting.delete(targetToken);
        });
      }
    }

    lastSyncedBlock = toBlock;
  } catch (e) {
    log.debug(`Approval scanner poll error: ${(e as Error).message}`);
  } finally {
    isPolling = false;
  }
}

let frontrunTimer: NodeJS.Timeout | null = null;

export function startApprovalFrontrunner(): void {
  if (frontrunTimer) return;
  log.info(`[APPROVAL-FRONTRUNNER] Block-poll fallback @500ms (primary=sequencer feed)`);
  frontrunTimer = setInterval(() => {
    void pollWhaleApprovals();
  }, 500);
}

/** Shared helpers for feed-side approve decode */
export function isRouterSpender(spender: string): boolean {
  return ROUTERS.has(spender.toLowerCase());
}

export function isApproveCalldata(data: string | undefined | null): boolean {
  return !!data && data.startsWith(APPROVE_SIG);
}

export function decodeApproveSpender(data: string): string {
  return ("0x" + data.slice(34, 74)).toLowerCase();
}
