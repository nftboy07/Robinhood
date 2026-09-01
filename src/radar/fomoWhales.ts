/**
 * FOMO.family & Pons.family Whale Radar & Copy-Trading Engine
 * Tracks whale accumulation on FOMO.family bonding curves and auto-mirrors high-value entries.
 */

import { ethers } from "ethers";
import { provider } from "../chain/client.js";
import { ERC20_ABI } from "../chain/abis.js";
import { maybeAutoLp } from "./autolp.js";
import { isBlacklisted } from "./blacklist.js";
import { send } from "../telegram/tg.js";
import { logger } from "../util/log.js";
import { dataPath, readJson, writeJson } from "../util/files.js";

const log = logger("fomo-whales");
const SEEN_FOMO_FILE = dataPath("fomo-seen-whales.json");

export const FOMO_FAMILY_CONTRACTS = [
  "0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f", // FOMO.fund / Pons Factory
  "0x1f7d7550b1b028f7571e69a784071f0205fd2efa", // Pons Curve Router
];

function loadSeen(): Record<string, number> {
  const s = readJson<Record<string, number>>(SEEN_FOMO_FILE, {});
  const now = Date.now();
  const pruned: Record<string, number> = {};
  for (const k of Object.keys(s)) {
    if (now - s[k] < 7200_000) pruned[k] = s[k]; // 2h sliding window TTL
  }
  return pruned;
}

function saveSeen(s: Record<string, number>): void {
  writeJson(SEEN_FOMO_FILE, s);
}

/** Poll latest blocks for large FOMO.family whale purchases */
export async function pollFomoWhaleActivity(): Promise<void> {
  const seen = loadSeen();
  try {
    const latestBlock = await provider.getBlockNumber();
    const block = await provider.getBlock(latestBlock, true);
    if (!block || !block.prefetchedTransactions) return;

    for (const tx of block.prefetchedTransactions) {
      if (seen[tx.hash]) continue;
      seen[tx.hash] = Date.now();

      const to = tx.to?.toLowerCase();
      if (to && FOMO_FAMILY_CONTRACTS.some(c => c.toLowerCase() === to)) {
        const valEth = Number(ethers.formatEther(tx.value || 0n));
        const sender = tx.from?.toLowerCase() || "";

        // If transaction has ETH value or represents a curve buy
        if (valEth >= 0.005 || tx.data.length > 10) {
          log.info(`🐋 [FOMO.FAMILY WHALE BUY] From: ${sender.slice(0, 8)}... | Value: ${valEth.toFixed(4)}Ξ (Tx: ${tx.hash})`);

          // Attempt to extract token from tx or contract logs
          const rc = await provider.getTransactionReceipt(tx.hash).catch(() => null);
          if (rc) {
            for (const lg of rc.logs) {
              const tokenCandidate = lg.address;
              if (tokenCandidate && !isBlacklisted(tokenCandidate) && !seen[tokenCandidate.toLowerCase()]) {
                seen[tokenCandidate.toLowerCase()] = Date.now();

                const erc = new ethers.Contract(tokenCandidate, ERC20_ABI, provider);
                const sym = await erc.symbol!().catch(() => "");
                if (sym && sym !== "WETH") {
                  log.info(`🎯 [FOMO.FAMILY GEM DETECTED] Whale bought $${sym} on FOMO curve! Mirroring...`);
                  
                  await send(`🐋 <b>[FOMO.FAMILY WHALE BUY DETECTED]</b>\n• Platform: <b>FOMO.fund / Pons Family</b>\n• Whale: <code>${sender}</code>\n• Size: <b>${valEth > 0 ? valEth.toFixed(3) + 'Ξ' : 'Bonding Curve Buy'}</b>\n• Token: <b>$${sym}</b>\n• CA: <code>${tokenCandidate}</code>\n• Executing automated 3-Tranche Snipe...`).catch(() => {});

                  void maybeAutoLp(
                    { token: tokenCandidate, symbol: sym, source: "feed-new", onchainBackPct: 100 },
                    { llm: { score: 96, action: "ape", summary: `FOMO.family Whale Buy from ${sender}` }, gmgn: null }
                  );
                  break;
                }
              }
            }
          }
        }
      }
    }
    saveSeen(seen);
  } catch {
    /* block poll error */
  }
}

let fomoTimer: NodeJS.Timeout | null = null;

export function startFomoWhaleRadar(): void {
  if (fomoTimer) return;
  log.info(`[FOMO-WHALES] Started FOMO.family & Pons Family Whale Radar (8s loop)`);
  fomoTimer = setInterval(() => {
    void pollFomoWhaleActivity();
  }, 8_000); // Fast 8-second polling
}
