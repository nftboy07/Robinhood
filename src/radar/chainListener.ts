/**
 * God-Mode Quad-Factory On-Chain Pool Sniping Engine
 *
 * - Monotonic block cursor advanced ONLY after successful getLogs
 * - In-memory seen set (debounced disk flush)
 * - Snipe fires BEFORE symbol/Telegram RPC
 */
import { ethers } from "ethers";
import { provider } from "../chain/client.js";
import { ERC20_ABI } from "../chain/abis.js";
import { rememberPoolFee } from "../chain/swaps.js";
import { maybeAutoLp } from "./autolp.js";
import { isBlacklisted } from "./blacklist.js";
import { send } from "../telegram/tg.js";
import { logger } from "../util/log.js";
import { dataPath, readJson, writeJson } from "../util/files.js";

const log = logger("chain-listener");
const SEEN_POOLS_FILE = dataPath("chain-seen-pools.json");

export const FACTORIES = [
  "0x1f7d7550b1b028f7571e69a784071f0205fd2efa".toLowerCase(),
  "0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f".toLowerCase(),
  "0x8366a39CC670B4001A1121B8F6A443A643e40951".toLowerCase(),
  "0x73991a25c818bf1f1128deaab1492d45638de0d3".toLowerCase(),
];

const WETH_ADDR = "0x0bd7d308f8e1639fab988df18a8011f41eacad73".toLowerCase();

const TOPIC_V3_POOL_CREATED = "0x783cca1c04124a23a8e62df366fef06b511d3ac0a597e6e839e94e47e15340db";
const TOPIC_V2_PAIR_CREATED = "0x0d3648bd0f6ee80134a33ba0f14a5119d2dfec688d366a110d2b30c37f1162bf";
const TOPIC_V4_INITIALIZE = "0x09ff44c7b8d4f4e24eb8703080ff72e59e359fe050fb3f9ba6c5ddcb48bc894b";
// ZeroHood / RobinPump PairCreated-equivalent (same V2 topic often reused; keep V2 in filter)
const TOPIC_ZEROHOOD_PAIR = TOPIC_V2_PAIR_CREATED;

let seenMem: Record<string, number> = readJson<Record<string, number>>(SEEN_POOLS_FILE, {});
let seenDirty = false;
let lastFlush = 0;

function markSeen(key: string): void {
  seenMem[key] = Date.now();
  seenDirty = true;
}

function flushSeen(force = false): void {
  const now = Date.now();
  if (!seenDirty && !force) return;
  if (!force && now - lastFlush < 5_000) return;
  const pruned: Record<string, number> = {};
  for (const k of Object.keys(seenMem)) {
    if (now - seenMem[k]! < 7200_000) pruned[k] = seenMem[k]!;
  }
  seenMem = pruned;
  writeJson(SEEN_POOLS_FILE, seenMem);
  seenDirty = false;
  lastFlush = now;
}

let lastSyncedBlock = 0;
let isPolling = false;

export async function pollNewPoolEvents(): Promise<void> {
  if (isPolling) return;
  isPolling = true;
  try {
    const curBlock = await provider.getBlockNumber();
    if (lastSyncedBlock === 0) {
      lastSyncedBlock = Math.max(0, curBlock - 3);
    }
    if (curBlock <= lastSyncedBlock) return;

    // Chunk large gaps to avoid RPC caps
    const fromBlock = lastSyncedBlock + 1;
    const toBlock = Math.min(curBlock, fromBlock + 199);

    let logs: ethers.Log[];
    try {
      logs = await provider.getLogs({
        fromBlock,
        toBlock,
        address: FACTORIES,
        topics: [[TOPIC_V3_POOL_CREATED, TOPIC_V2_PAIR_CREATED, TOPIC_V4_INITIALIZE, TOPIC_ZEROHOOD_PAIR]],
      });
    } catch (e) {
      log.debug(`getLogs failed [${fromBlock},${toBlock}]: ${(e as Error).message}`);
      // Do NOT advance cursor on failure
      return;
    }

    // Advance cursor only after successful fetch
    lastSyncedBlock = toBlock;

    for (const lg of logs) {
      const topic0 = lg.topics[0]?.toLowerCase();
      let token0 = "";
      let token1 = "";
      let poolAddr = "";
      let version = "V3";
      let fee = 10000;

      if (topic0 === TOPIC_V3_POOL_CREATED.toLowerCase() && lg.topics.length >= 3) {
        token0 = ("0x" + lg.topics[1]!.slice(26)).toLowerCase();
        token1 = ("0x" + lg.topics[2]!.slice(26)).toLowerCase();
        if (lg.topics.length >= 4) {
          try {
            fee = Number(BigInt(lg.topics[3]));
          } catch {
            fee = 10000;
          }
        }
        // pool is the trailing address in data
        poolAddr = ("0x" + lg.data.slice(-40)).toLowerCase();
        version = "Uniswap V3";
      } else if (
        (topic0 === TOPIC_V2_PAIR_CREATED.toLowerCase() || topic0 === TOPIC_ZEROHOOD_PAIR.toLowerCase()) &&
        lg.topics.length >= 3
      ) {
        token0 = ("0x" + lg.topics[1]!.slice(26)).toLowerCase();
        token1 = ("0x" + lg.topics[2]!.slice(26)).toLowerCase();
        poolAddr = ("0x" + lg.data.slice(26, 66)).toLowerCase();
        version = "V2 / FOMO / ZeroHood";
        fee = 3000;
      } else if (topic0 === TOPIC_V4_INITIALIZE.toLowerCase() && lg.topics.length >= 3) {
        token0 = ("0x" + lg.topics[1]!.slice(26)).toLowerCase();
        token1 = ("0x" + lg.topics[2]!.slice(26)).toLowerCase();
        poolAddr = lg.address.toLowerCase();
        version = "Uniswap V4";
      } else {
        continue;
      }

      if (!poolAddr || seenMem[poolAddr]) continue;
      markSeen(poolAddr);

      let targetToken = "";
      if (token0 === WETH_ADDR) targetToken = token1;
      else if (token1 === WETH_ADDR) targetToken = token0;
      else targetToken = token0;

      if (!targetToken || isBlacklisted(targetToken) || seenMem[targetToken]) continue;
      markSeen(targetToken);
      rememberPoolFee(targetToken, fee);

      // SNIPE FIRST — symbol + Telegram async
      const symbolHint = targetToken.slice(0, 8);
      void maybeAutoLp(
        { token: targetToken, symbol: symbolHint, source: "feed-new", fee, onchainBackPct: 100 },
        { llm: { score: 98, action: "ape", summary: `Instant Quad-Factory ${version} Snipe` }, gmgn: null },
      );

      void (async () => {
        try {
          const erc = new ethers.Contract(targetToken, ERC20_ABI, provider);
          const symbol: string = await erc.symbol!().catch(() => symbolHint);
          log.info(
            `⚡ [ON-CHAIN ${version} POOL DETECTED] $${symbol} (${targetToken}) Pool: ${poolAddr} Tx: ${lg.transactionHash}`,
          );
          void send(
            `🎯 <b>[NEW ${version.toUpperCase()} POOL DETECTED! ⚡]</b>\n• Token: <b>$${symbol}</b>\n• Pool: <code>${poolAddr}</code>\n• CA: <code>${targetToken}</code>\n• Block: <b>#${lg.blockNumber}</b>\n• Snipe dispatched (fire-before-notify)`,
          ).catch(() => {});
        } catch {
          /* ignore */
        }
      })();
    }

    flushSeen();
  } catch (e) {
    log.debug(`Pool listener poll error: ${(e as Error).message}`);
  } finally {
    isPolling = false;
  }
}

let listenerTimer: NodeJS.Timeout | null = null;

export function startChainPoolListener(): void {
  if (listenerTimer) return;
  log.info(`[CHAIN-LISTENER] Quad-Factory scanner @200ms (cursor-safe, snipe-first)`);
  listenerTimer = setInterval(() => {
    void pollNewPoolEvents();
  }, 200);
}
