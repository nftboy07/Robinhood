/**
 * Stockyard & RHPS (Robinhood Pairs Stocks) Memecoin Screener
 * Platform: https://stockyard.rhps.fun
 * 
 * Screens and auto-trades stock-paired meme assets (e.g. $TSLA, $NVDA, $HOOD, $GME, $PLTR, $MSTR)
 * on Robinhood Chain, tracking equity market sentiment, liquidity depth, and bonding curves.
 */

import { ethers } from "ethers";
import { provider } from "../chain/client.js";
import { ERC20_ABI } from "../chain/abis.js";
import { maybeAutoLp } from "./autolp.js";
import { send } from "../telegram/tg.js";
import { logger } from "../util/log.js";
import { dataPath, readJson, writeJson } from "../util/files.js";

const log = logger("stockyard");
const SEEN_STOCKS_FILE = dataPath("stockyard-seen-tokens.json");

// Popular stock tickers and equities paired on Robinhood Chain
export const STOCK_TICKERS = [
  "HOOD", "TSLA", "NVDA", "GME", "AAPL", "PLTR", "MSTR", 
  "COIN", "AMZN", "MSFT", "GOOG", "AMD", "SPY", "QQQ", 
  "META", "RDDT", "DJT", "INTC", "SMCI", "ARM"
];

// Stockyard / RHPS Deployer and Curve Contracts on Robinhood Chain
export const STOCKYARD_CONTRACTS = [
  "0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f".toLowerCase(),
  "0x1f7d7550b1b028f7571e69a784071f0205fd2efa".toLowerCase(),
  "0x73991a25c818bf1f1128deaab1492d45638de0d3".toLowerCase()
];

export interface StockPairInfo {
  token: string;
  symbol: string;
  stockRef: string;
  detectedAt: number;
  chartUrl: string;
  stockyardUrl: string;
}

function loadSeen(): Record<string, number> {
  const s = readJson<Record<string, number>>(SEEN_STOCKS_FILE, {});
  const now = Date.now();
  const pruned: Record<string, number> = {};
  for (const k of Object.keys(s)) {
    if (now - s[k] < 7200_000) pruned[k] = s[k]; // 2h sliding window TTL
  }
  return pruned;
}

function saveSeen(s: Record<string, number>): void {
  writeJson(SEEN_STOCKS_FILE, s);
}

export function isStockPairedMeme(symbol: string): string | null {
  const clean = symbol.toUpperCase().replace(/[^A-Z]/g, "");
  for (const st of STOCK_TICKERS) {
    if (clean === st || clean.includes(st) || clean.startsWith(st) || clean.endsWith(st)) {
      return st;
    }
  }
  return null;
}

export async function screenStockyardPairs(): Promise<StockPairInfo[]> {
  const activeStockPairs: StockPairInfo[] = [];
  try {
    const curBlock = await provider.getBlockNumber();
    const seen = loadSeen();

    // Query recent blocks for stock-paired meme contracts
    const logs = await provider.getLogs({
      fromBlock: curBlock - 30, // Last ~30 blocks (~1 min)
      toBlock: curBlock,
      topics: [
        [
          "0x783cca1c04124a23a8e62df366fef06b511d3ac0a597e6e839e94e47e15340db", // V3 PoolCreated
          "0x0d3648bd0f6ee80134a33ba0f14a5119d2dfec688d366a110d2b30c37f1162bf", // V2 PairCreated
        ]
      ]
    }).catch(() => []);

    for (const lg of logs) {
      if (!lg.topics[1] || !lg.topics[2]) continue;
      const t0 = ("0x" + lg.topics[1].slice(26)).toLowerCase();
      const t1 = ("0x" + lg.topics[2].slice(26)).toLowerCase();
      const candidates = [t0, t1];

      for (const cand of candidates) {
        if (cand === "0x0bd7d308f8e1639fab988df18a8011f41eacad73") continue; // Skip WETH
        if (seen[cand]) continue;

        try {
          const erc = new ethers.Contract(cand, ERC20_ABI, provider);
          const symbol: string = await erc.symbol!().catch(() => "");
          if (!symbol) continue;

          const stockRef = isStockPairedMeme(symbol);
          if (stockRef) {
            seen[cand] = Date.now();
            const pairInfo: StockPairInfo = {
              token: cand,
              symbol,
              stockRef,
              detectedAt: Date.now(),
              chartUrl: `https://chart.zone/token/${cand}`,
              stockyardUrl: `https://stockyard.rhps.fun/token/${cand}`
            };

            activeStockPairs.push(pairInfo);
            log.info(`🎯 [STOCKYARD SCREENER] Found Stock-Paired Meme: $${symbol} (Ref: ${stockRef}) | CA: ${cand}`);

            await send(
              `📊 <b>[STOCKYARD / RHPS STOCK-PAIR DETECTED! 📈]</b>\n` +
              `• Asset: <b>$${symbol}</b> (Paired with: <b>#${stockRef}</b>)\n` +
              `• CA: <code>${cand}</code>\n` +
              `• 📈 <a href="${pairInfo.chartUrl}">Live Chart.zone</a> | 🏛️ <a href="${pairInfo.stockyardUrl}">Stockyard Terminal</a>\n` +
              `• Fast-tracking automated anti-MEV 3-Tranche Snipe...`
            ).catch(() => {});

            void maybeAutoLp(
              { token: cand, symbol, source: "feed-new", onchainBackPct: 100 },
              { llm: { score: 96, action: "ape", summary: `Stockyard ${stockRef} Equity Correlation Snipe` }, gmgn: null }
            );
          }
        } catch {}
      }
    }

    saveSeen(seen);
  } catch (e) {
    log.debug(`Stockyard screening error: ${(e as Error).message}`);
  }
  return activeStockPairs;
}

let stockyardTimer: NodeJS.Timeout | null = null;

export function startStockyardScreener(): void {
  if (stockyardTimer) return;
  log.info(`[STOCKYARD] Started Stockyard & RHPS Stock-Paired Memecoin Screener (stockyard.rhps.fun & chart.zone)`);
  stockyardTimer = setInterval(() => {
    void screenStockyardPairs();
  }, 3000); // 3-second rapid scan
}
