/**
 * God-Mode Quad-Factory On-Chain Pool Sniping Engine
 * 
 * 1. Monitored Factories:
 *    - Uniswap V3 Factory (0x1f7d7550b1b028f7571e69a784071f0205fd2efa) -> PoolCreated
 *    - Uniswap V2 / FOMO.fund / Pons Factory (0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f) -> PairCreated
 *    - Uniswap V4 PoolManager (0x8366a39CC670B4001A1121B8F6A443A643e40951) -> Initialize
 *    - ZeroHood / RobinPump Factory (0x73991a25c818bf1f1128deaab1492d45638de0d3)
 * 2. 500ms Sub-Second Micro-Loop
 * 3. Atomic Single-RPC Batch Query
 * 4. Instant Dynamic Priority Tip Boost (+0.3 Gwei)
 */

import { ethers } from "ethers";
import { provider } from "../chain/client.js";
import { ERC20_ABI } from "../chain/abis.js";
import { maybeAutoLp } from "./autolp.js";
import { isBlacklisted } from "./blacklist.js";
import { send } from "../telegram/tg.js";
import { logger } from "../util/log.js";
import { dataPath, readJson, writeJson } from "../util/files.js";

const log = logger("chain-listener");
const SEEN_POOLS_FILE = dataPath("chain-seen-pools.json");

// Quad-Factory Addresses on Robinhood Chain
export const FACTORIES = [
  "0x1f7d7550b1b028f7571e69a784071f0205fd2efa".toLowerCase(), // Uniswap V3 / Noxa
  "0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f".toLowerCase(), // V2 / FOMO.fund / Pons
  "0x8366a39CC670B4001A1121B8F6A443A643e40951".toLowerCase(), // Uniswap V4 PoolManager
  "0x73991a25c818bf1f1128deaab1492d45638de0d3".toLowerCase(), // ZeroHood / RobinPump
];

const WETH_ADDR = "0x0bd7d308f8e1639fab988df18a8011f41eacad73".toLowerCase();

// Topic 0 Signatures
const TOPIC_V3_POOL_CREATED = "0x783cca1c04124a23a8e62df366fef06b511d3ac0a597e6e839e94e47e15340db";
const TOPIC_V2_PAIR_CREATED = "0x0d3648bd0f6ee80134a33ba0f14a5119d2dfec688d366a110d2b30c37f1162bf";
const TOPIC_V4_INITIALIZE   = "0x09ff44c7b8d4f4e24eb8703080ff72e59e359fe050fb3f9ba6c5ddcb48bc894b";

function loadSeenPools(): Record<string, number> {
  const s = readJson<Record<string, number>>(SEEN_POOLS_FILE, {});
  const now = Date.now();
  const pruned: Record<string, number> = {};
  for (const k of Object.keys(s)) {
    if (now - s[k] < 7200_000) pruned[k] = s[k]; // 2-hour sliding window TTL
  }
  return pruned;
}

function saveSeenPools(s: Record<string, number>): void {
  writeJson(SEEN_POOLS_FILE, s);
}

let lastSyncedBlock = 0;
let isPolling = false;

export async function pollNewPoolEvents(): Promise<void> {
  if (isPolling) return;
  isPolling = true;
  try {
    const curBlock = await provider.getBlockNumber();
    if (lastSyncedBlock === 0) {
      lastSyncedBlock = curBlock - 3;
    }
    if (curBlock <= lastSyncedBlock) {
      isPolling = false;
      return;
    }

    const fromBlock = lastSyncedBlock + 1;
    const toBlock = curBlock;
    lastSyncedBlock = toBlock;

    const seen = loadSeenPools();

    // Quad-Factory combined eth_getLogs in 1 single RPC round-trip
    const logs = await provider.getLogs({
      fromBlock,
      toBlock,
      address: FACTORIES,
      topics: [[TOPIC_V3_POOL_CREATED, TOPIC_V2_PAIR_CREATED, TOPIC_V4_INITIALIZE]],
    }).catch(() => []);

    for (const lg of logs) {
      const topic0 = lg.topics[0]?.toLowerCase();
      let token0 = "";
      let token1 = "";
      let poolAddr = "";
      let version = "V3";

      if (topic0 === TOPIC_V3_POOL_CREATED.toLowerCase() && lg.topics.length >= 3) {
        token0 = ("0x" + lg.topics[1].slice(26)).toLowerCase();
        token1 = ("0x" + lg.topics[2].slice(26)).toLowerCase();
        poolAddr = ("0x" + lg.data.slice(26, 66)).toLowerCase();
        version = "Uniswap V3";
      } else if (topic0 === TOPIC_V2_PAIR_CREATED.toLowerCase() && lg.topics.length >= 3) {
        token0 = ("0x" + lg.topics[1].slice(26)).toLowerCase();
        token1 = ("0x" + lg.topics[2].slice(26)).toLowerCase();
        poolAddr = ("0x" + lg.data.slice(26, 66)).toLowerCase();
        version = "V2 / FOMO.fund";
      } else if (topic0 === TOPIC_V4_INITIALIZE.toLowerCase() && lg.topics.length >= 3) {
        token0 = ("0x" + lg.topics[1].slice(26)).toLowerCase();
        token1 = ("0x" + lg.topics[2].slice(26)).toLowerCase();
        poolAddr = lg.address.toLowerCase();
        version = "Uniswap V4";
      } else {
        continue;
      }

      if (seen[poolAddr]) continue;
      seen[poolAddr] = Date.now();

      let targetToken = "";
      if (token0 === WETH_ADDR) targetToken = token1;
      else if (token1 === WETH_ADDR) targetToken = token0;
      else targetToken = token0;

      if (!targetToken || isBlacklisted(targetToken) || seen[targetToken]) continue;
      seen[targetToken] = Date.now();

      try {
        const erc = new ethers.Contract(targetToken, ERC20_ABI, provider);
        const symbol: string = await erc.symbol!().catch(() => "");
        if (symbol && symbol !== "WETH") {
          log.info(`⚡ [ON-CHAIN ${version} POOL DETECTED] $${symbol} (${targetToken}) in Pool: ${poolAddr} (Tx: ${lg.transactionHash})`);
          
          await send(`🎯 <b>[NEW ${version.toUpperCase()} POOL DETECTED! ⚡]</b>\n• Token: <b>$${symbol}</b>\n• Pool: <code>${poolAddr}</code>\n• CA: <code>${targetToken}</code>\n• Block: <b>#${lg.blockNumber}</b>\n• Submitting 3-Tranche Snipe with +0.3 Gwei priority boost...`).catch(() => {});

          void maybeAutoLp(
            { token: targetToken, symbol, source: "feed-new", onchainBackPct: 100 },
            { llm: { score: 98, action: "ape", summary: `Instant Quad-Factory ${version} Snipe` }, gmgn: null }
          );
        }
      } catch {
        /* token lookup error */
      }
    }

    saveSeenPools(seen);
  } catch (e) {
    log.debug(`Pool listener poll error: ${(e as Error).message}`);
  } finally {
    isPolling = false;
  }
}

let listenerTimer: NodeJS.Timeout | null = null;

export function startChainPoolListener(): void {
  if (listenerTimer) return;
  log.info(`[CHAIN-LISTENER] Started God-Mode Quad-Factory Pool Scanner (500ms sub-second micro-loop)`);
  listenerTimer = setInterval(() => {
    void pollNewPoolEvents();
  }, 200); // Ultra-fast 500ms micro-loop
}
