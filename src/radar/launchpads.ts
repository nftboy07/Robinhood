/**
 * Robinhood Chain Native Launchpads & Bonding Curve Engine
 * Monotonic block cursor + snipe-before-notify.
 */
import { ethers } from "ethers";
import { provider } from "../chain/client.js";
import { ERC20_ABI } from "../chain/abis.js";
import { maybeAutoLp } from "./autolp.js";
import { isBlacklisted } from "./blacklist.js";
import { send } from "../telegram/tg.js";
import { logger } from "../util/log.js";
import { dataPath, readJson, writeJson } from "../util/files.js";

const log = logger("launchpads");
const SEEN_LAUNCH_FILE = dataPath("launchpad-seen-tokens.json");

export const LAUNCHPAD_FACTORIES: Record<string, string> = {
  "0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f": "FOMO.fund / Pons Family",
  "0x1f7d7550b1b028f7571e69a784071f0205fd2efa": "Noxa.fun Curve Factory",
  "0x73991a25c818bf1f1128deaab1492d45638de0d3": "ZeroHood / RobinPump",
  "0xca143ce32fe78f1f7019d7d551a6402fc5350c73": "Sherwood / Bankr AI Deployer",
};

let seenMem: Record<string, number> = readJson(SEEN_LAUNCH_FILE, {});
let lastSyncedBlock = 0;
let isPolling = false;

function markSeen(k: string): void {
  seenMem[k] = Date.now();
}

function flushSeen(): void {
  const now = Date.now();
  const pruned: Record<string, number> = {};
  for (const k of Object.keys(seenMem)) {
    if (now - seenMem[k]! < 7200_000) pruned[k] = seenMem[k]!;
  }
  seenMem = pruned;
  writeJson(SEEN_LAUNCH_FILE, seenMem);
}

export async function pollNativeLaunchpads(): Promise<void> {
  if (isPolling) return;
  isPolling = true;
  try {
    const tip = await provider.getBlockNumber();
    if (lastSyncedBlock === 0) lastSyncedBlock = tip - 1;
    if (tip <= lastSyncedBlock) return;

    const from = lastSyncedBlock + 1;
    const to = Math.min(tip, from + 8);

    for (let b = from; b <= to; b++) {
      const block = await provider.getBlock(b, true);
      if (!block?.prefetchedTransactions) continue;

      for (const tx of block.prefetchedTransactions) {
        if (seenMem[tx.hash]) continue;
        markSeen(tx.hash);

        const toAddr = tx.to?.toLowerCase();
        const fromAddr = tx.from?.toLowerCase();
        const platform = (toAddr && LAUNCHPAD_FACTORIES[toAddr]) || (fromAddr && LAUNCHPAD_FACTORIES[fromAddr]);
        if (!platform) continue;

        const targetToken = tx.to;
        if (!targetToken || isBlacklisted(targetToken)) continue;
        const key = targetToken.toLowerCase();
        if (seenMem[key]) continue;
        markSeen(key);

        log.info(`🚀 [LAUNCHPAD] ${platform} tx=${tx.hash}`);
        void maybeAutoLp(
          { token: targetToken, symbol: key.slice(0, 8), source: "feed-new", onchainBackPct: 100 },
          { llm: { score: 92, action: "ape", summary: `Fresh ${platform} launchpad token` }, gmgn: null },
        );

        void (async () => {
          const contract = new ethers.Contract(targetToken, ERC20_ABI, provider);
          const symbol: string = await contract.symbol!().catch(() => "");
          if (symbol) {
            void send(
              `🚀 <b>[NEW LAUNCHPAD GEM]</b>\n• Platform: <b>${platform}</b>\n• Token: <b>$${symbol}</b>\n• CA: <code>${targetToken}</code>`,
            ).catch(() => {});
          }
        })();
      }
    }

    lastSyncedBlock = to;
    flushSeen();
  } catch {
    /* don't advance on hard failure of tip fetch — per-block errors skip that block via continue */
  } finally {
    isPolling = false;
  }
}

let launchTimer: NodeJS.Timeout | null = null;

export function startLaunchpadScanner(): void {
  if (launchTimer) return;
  log.info(`[LAUNCHPADS] Native launchpad scanner @2s (cursor-safe, snipe-first)`);
  launchTimer = setInterval(() => {
    void pollNativeLaunchpads();
  }, 2000);
}
