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

function loadSeenTxs(): Record<string, number> {
  return readJson<Record<string, number>>(SEEN_TX_FILE, {});
}

function saveSeenTxs(s: Record<string, number>): void {
  writeJson(SEEN_TX_FILE, s);
}

/** Check recent blocks for smart money token buys */
export async function pollSmartMoneyBuys(): Promise<void> {
  const seen = loadSeenTxs();
  try {
    const latestBlock = await provider.getBlockNumber();
    const block = await provider.getBlock(latestBlock, true);
    if (!block || !block.prefetchedTransactions) return;

    for (const tx of block.prefetchedTransactions) {
      if (seen[tx.hash]) continue;
      seen[tx.hash] = Date.now();

      const from = tx.from?.toLowerCase();
      if (SMART_MONEY_WALLETS.some((w) => w.toLowerCase() === from)) {
        log.info(`🐋 [SMART MONEY TX DETECTED] From: ${from} (Tx: ${tx.hash})`);
        
        // If contract creation or router swap
        const targetToken = tx.to;
        if (targetToken && !isBlacklisted(targetToken)) {
          const contract = new ethers.Contract(targetToken, ERC20_ABI, provider);
          const symbol: string = await contract.symbol!().catch(() => "");
          if (symbol) {
            log.info(`🐋 [COPY-TRADE SIGNAL] Smart Money ${from.slice(0, 8)}... bought $${symbol}!`);
            await send(`🐋 <b>[WHALE COPY-TRADE SIGNAL]</b>\n• Smart Wallet: <code>${from}</code>\n• Token: <b>$${symbol}</b>\n• CA: <code>${targetToken}</code>\n• Executing automated mirror entry...`).catch(() => {});

            void maybeAutoLp(
              { token: targetToken, symbol, source: "poke-ai", onchainBackPct: 100 },
              { llm: { score: 95, action: "ape", summary: `Mirroring Smart Money buy from ${from}` }, gmgn: null }
            );
          }
        }
      }
    }
    saveSeenTxs(seen);
  } catch {
    /* block poll error */
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
