/**
 * Robinhood Chain Native Launchpads & Bonding Curve Engine
 * 
 * Monitors:
 * 1. FOMO.fund & Pons.family (Robinhood Premier Meme Launchpad)
 * 2. Noxa.fun (Native Bonding Curve)
 * 3. ZeroHood.fun & RobinPump
 * 4. Sherwood & Bankr AI Agent Deployers
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

// Known Factory & Deployer Contracts on Robinhood Chain
export const LAUNCHPAD_FACTORIES: Record<string, string> = {
  "0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f": "FOMO.fund / Pons Family",
  "0x1f7d7550b1b028f7571e69a784071f0205fd2efa": "Noxa.fun Curve Factory",
  "0x73991a25c818bf1f1128deaab1492d45638de0d3": "ZeroHood / RobinPump",
  "0xca143ce32fe78f1f7019d7d551a6402fc5350c73": "Sherwood / Bankr AI Deployer",
};

function loadSeen(): Record<string, number> {
  return readJson<Record<string, number>>(SEEN_LAUNCH_FILE, {});
}

function saveSeen(s: Record<string, number>): void {
  writeJson(SEEN_LAUNCH_FILE, s);
}

/** Check recent blocks for fresh token creations or curve graduations from native launchpads */
export async function pollNativeLaunchpads(): Promise<void> {
  const seen = loadSeen();
  try {
    const latestBlock = await provider.getBlockNumber();
    const block = await provider.getBlock(latestBlock, true);
    if (!block || !block.prefetchedTransactions) return;

    for (const tx of block.prefetchedTransactions) {
      if (seen[tx.hash]) continue;
      seen[tx.hash] = Date.now();

      const to = tx.to?.toLowerCase();
      const from = tx.from?.toLowerCase();

      // Check if transaction interacted with a known meme launchpad factory
      const platform = (to && LAUNCHPAD_FACTORIES[to]) || (from && LAUNCHPAD_FACTORIES[from]);
      if (platform) {
        log.info(`🚀 [LAUNCHPAD ACTIVITY DETECTED] Platform: ${platform} (Tx: ${tx.hash})`);

        // Check if contract creation or recipient token
        const targetToken = tx.to;
        if (targetToken && !isBlacklisted(targetToken)) {
          const contract = new ethers.Contract(targetToken, ERC20_ABI, provider);
          const symbol: string = await contract.symbol!().catch(() => "");
          if (symbol && !seen[targetToken.toLowerCase()]) {
            seen[targetToken.toLowerCase()] = Date.now();
            log.info(`🎯 [LAUNCHPAD GEM DISCOVERED] $${symbol} launched on ${platform}!`);
            
            await send(`🚀 <b>[NEW LAUNCHPAD GEM]</b>\n• Platform: <b>${platform}</b>\n• Token: <b>$${symbol}</b>\n• CA: <code>${targetToken}</code>\n• Fast-tracking automated 3-Tranche Snipe...`).catch(() => {});

            void maybeAutoLp(
              { token: targetToken, symbol, source: "feed-new", onchainBackPct: 100 },
              { llm: { score: 92, action: "ape", summary: `Fresh ${platform} launchpad token` }, gmgn: null }
            );
          }
        }
      }
    }
    saveSeen(seen);
  } catch {
    /* block poll error */
  }
}

let launchTimer: NodeJS.Timeout | null = null;

export function startLaunchpadScanner(): void {
  if (launchTimer) return;
  log.info(`[LAUNCHPADS] Started Robinhood Native Launchpad Scanner (FOMO.fund, Pons Family, Noxa, ZeroHood)`);
  launchTimer = setInterval(() => {
    void pollNativeLaunchpads();
  }, 10_000); // Fast 10s scanner loop
}
