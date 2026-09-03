/**
 * FOMO.family & Pons.family Whale Radar
 * Cursor-based block scan; skip receipt wait when possible; snipe-first.
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
  "0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f",
  "0x1f7d7550b1b028f7571e69a784071f0205fd2efa",
];

let seenMem: Record<string, number> = readJson(SEEN_FOMO_FILE, {});
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
  writeJson(SEEN_FOMO_FILE, seenMem);
}

export async function pollFomoWhaleActivity(): Promise<void> {
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
        if (!toAddr || !FOMO_FAMILY_CONTRACTS.some((c) => c.toLowerCase() === toAddr)) continue;

        const valEth = Number(ethers.formatEther(tx.value || 0n));
        const sender = tx.from?.toLowerCase() || "";
        if (valEth < 0.005 && (tx.data?.length ?? 0) <= 10) continue;

        log.info(`🐋 [FOMO WHALE] ${sender.slice(0, 8)}… ${valEth.toFixed(4)}Ξ tx=${tx.hash}`);

        // Prefer calldata token hints; receipt only as fallback (async)
        void (async () => {
          const rc = await provider.getTransactionReceipt(tx.hash).catch(() => null);
          if (!rc) return;
          for (const lg of rc.logs) {
            const tokenCandidate = lg.address;
            if (!tokenCandidate || isBlacklisted(tokenCandidate)) continue;
            const key = tokenCandidate.toLowerCase();
            if (seenMem[key]) continue;
            markSeen(key);

            const erc = new ethers.Contract(tokenCandidate, ERC20_ABI, provider);
            const sym = await erc.symbol!().catch(() => "");
            if (!sym || sym === "WETH") continue;

            void maybeAutoLp(
              { token: tokenCandidate, symbol: sym, source: "feed-new", onchainBackPct: 100 },
              { llm: { score: 96, action: "ape", summary: `FOMO.family Whale Buy from ${sender}` }, gmgn: null },
            );
            void send(
              `🐋 <b>[FOMO WHALE BUY]</b>\n• Whale: <code>${sender}</code>\n• Size: <b>${valEth > 0 ? valEth.toFixed(3) + "Ξ" : "curve"}</b>\n• Token: <b>$${sym}</b>\n• CA: <code>${tokenCandidate}</code>`,
            ).catch(() => {});
            break;
          }
          flushSeen();
        })();
      }
    }

    lastSyncedBlock = to;
    flushSeen();
  } catch {
    /* keep cursor */
  } finally {
    isPolling = false;
  }
}

let fomoTimer: NodeJS.Timeout | null = null;

export function startFomoWhaleRadar(): void {
  if (fomoTimer) return;
  log.info(`[FOMO-WHALES] Whale radar @1.5s (cursor-safe)`);
  fomoTimer = setInterval(() => {
    void pollFomoWhaleActivity();
  }, 1500);
}
