/**
 * Whale & Smart Money Copy-Trading Engine
 * Mirrors trades from top profitable Robinhood Chain degens and smart money wallets.
 */
import { ethers } from "ethers";
import { provider } from "../chain/client.js";
import { ERC20_ABI } from "../chain/abis.js";
import { maybeAutoLp } from "./autolp.js";
import { isBlacklisted } from "./blacklist.js";
import { send } from "../telegram/tg.js";
import { logger } from "../util/log.js";
import { dataPath, readJson, writeJson } from "../util/files.js";

const log = logger("copy-trader");
const SEEN_TX_FILE = dataPath("whale-seen-txs.json");

// Top Profitable Smart Degen Wallets & Whale Callers on Robinhood Chain
export const SMART_MONEY_WALLETS = [
  "0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f", // Top Robinhood Ecosystem Deployer
  "0xcaf681a66d020601342297493863e78c959e5cb2", // Dex Router
  "0x73991a25c818bf1f1128deaab1492d45638de0d3", // Top LP Whale
  "0x1f7d7550b1b028f7571e69a784071f0205fd2efa"  // Core Factory
];

let lastSyncedBlock = 0;
let isPolling = false;
let seenMem: Record<string, number> = readJson<Record<string, number>>(SEEN_TX_FILE, {});

export async function pollSmartMoneyBuys(): Promise<void> {
  if (isPolling) return;
  isPolling = true;
  try {
    const tip = await provider.getBlockNumber();
    if (lastSyncedBlock === 0) lastSyncedBlock = tip - 1;
    if (tip <= lastSyncedBlock) return;

    const fromB = lastSyncedBlock + 1;
    const toB = Math.min(tip, fromB + 8);

    for (let b = fromB; b <= toB; b++) {
      const block = await provider.getBlock(b, true);
      if (!block?.prefetchedTransactions) continue;

      for (const tx of block.prefetchedTransactions) {
        if (seenMem[tx.hash]) continue;
        seenMem[tx.hash] = Date.now();

        const from = tx.from?.toLowerCase();
        if (!SMART_MONEY_WALLETS.some((w) => w.toLowerCase() === from)) continue;

        log.info(`🐋 [SMART MONEY TX] From: ${from} (Tx: ${tx.hash})`);
        const targetToken = tx.to;
        if (!targetToken || isBlacklisted(targetToken)) continue;

        void maybeAutoLp(
          { token: targetToken, symbol: targetToken.slice(0, 8), source: "poke-ai", onchainBackPct: 100 },
          { llm: { score: 95, action: "ape", summary: `Mirroring Smart Money buy from ${from}` }, gmgn: null },
        );

        void (async () => {
          const contract = new ethers.Contract(targetToken, ERC20_ABI, provider);
          const symbol: string = await contract.symbol!().catch(() => "");
          if (symbol) {
            void send(
              `🐋 <b>[WHALE COPY-TRADE SIGNAL]</b>\n• Smart Wallet: <code>${from}</code>\n• Token: <b>$${symbol}</b>\n• CA: <code>${targetToken}</code>`,
            ).catch(() => {});
          }
        })();
      }
    }

    lastSyncedBlock = toB;
    writeJson(SEEN_TX_FILE, seenMem);
  } catch {
    /* keep cursor */
  } finally {
    isPolling = false;
  }
}

let copyTimer: NodeJS.Timeout | null = null;

export function startCopyTrader(): void {
  if (copyTimer) return;
  log.info(`[COPY-TRADER] Started Smart Money Whale Copy-Trading Engine (${SMART_MONEY_WALLETS.length} tracked wallets)`);
  copyTimer = setInterval(() => {
    void pollSmartMoneyBuys();
  }, 15_000); // Poll every 15s
}
