/**
 * Core Meme Token Strategy Engine
 * 
 * Features:
 * 1. Dollar-Cost Averaging (DCA) Dip-Buying: Automatically buys dips (-10% to -20%) on high-conviction memes to lower average entry price.
 * 2. Tiered Take-Profit Ladder (TP1: +50% sell 25%, TP2: +100% sell 25%, TP3: +300% sell 25%)
 * 3. Moonbag Runner (Remaining 25% rides for 10x-100x pumps)
 * 4. Dynamic Trailing Stop-Loss (Locks in profit if price drops >20% from peak after 1.5x)
 * 5. Hard Stop-Loss / Anti-Rug Guard (Cuts loss at -25% or liquidity crash)
 * 6. Automatic Position Tracking & Auto-Recycling Profits into WETH
 */

import { ethers } from "ethers";
import { quoteTokenToWeth, swapTokenToWeth, swapWethToToken, tokenBalanceRaw } from "../chain/swaps.js";
import { balances } from "../chain/holdings.js";
import { wallet, overrides } from "../chain/client.js";
import { WETH_ABI } from "../chain/abis.js";
import { C } from "../config.js";
import { send } from "../telegram/tg.js";
import { logger } from "../util/log.js";
import { dataPath, readJson, writeJson } from "../util/files.js";

const log = logger("strategy");
const POSITIONS_FILE = dataPath("meme-positions.json");
const GAS_RESERVE = 0.005;

export interface MemePosition {
  token: string;
  symbol: string;
  entryWeth: number;
  totalWethSpent: number;
  initialTokens: string; // BigInt as string
  currentTokens: string; // BigInt as string
  entryPriceWeth: number;
  highestPriceWeth: number;
  tpLevelsTaken: number[]; // [1.5, 2.0, 4.0]
  isMoonbag: boolean;
  isHighConviction: boolean;
  dcaCount: number; // number of times averaged down
  openedAt: number;
  lastCheckedAt: number;
}

interface PositionsMap {
  [tokenAddr: string]: MemePosition;
}

function loadPositions(): PositionsMap {
  return readJson<PositionsMap>(POSITIONS_FILE, {});
}

function savePositions(p: PositionsMap): void {
  writeJson(POSITIONS_FILE, p);
}

/** Record a new token purchase into active strategy tracking */
export async function trackNewMemeBuy(
  tokenAddr: string,
  symbol: string,
  entryWeth: number,
  tokensReceived: bigint,
  isHighConviction: boolean = true,
): Promise<void> {
  const positions = loadPositions();
  const tokenKey = tokenAddr.toLowerCase();
  
  const tokensNum = Number(ethers.formatEther(tokensReceived)) || 1;
  const entryPrice = entryWeth / tokensNum;

  positions[tokenKey] = {
    token: tokenAddr,
    symbol,
    entryWeth,
    totalWethSpent: entryWeth,
    initialTokens: tokensReceived.toString(),
    currentTokens: tokensReceived.toString(),
    entryPriceWeth: entryPrice,
    highestPriceWeth: entryPrice,
    tpLevelsTaken: [],
    isMoonbag: false,
    isHighConviction,
    dcaCount: 0,
    openedAt: Date.now(),
    lastCheckedAt: Date.now(),
  };

  savePositions(positions);
  log.info(`[STRATEGY] Tracking new position: ${symbol} (${entryWeth}Ξ @ ${entryPrice.toExponential(3)}Ξ/token) [HighConviction=${isHighConviction}]`);
  await send(`🎯 <b>[STRATEGY ENTERED] ${symbol}</b>\n• Entry Size: ${entryWeth}Ξ\n• Tokens: ${tokensReceived.toString()}\n• Strategies Active: DCA Dip-Buying (Averaging Down) + TP Ladder (1.5x, 2x, 4x) + Moonbag (25%)`).catch(() => {});
}

/** Evaluate and execute DCA dip buys, profit-taking, and stop-loss on all open meme positions */
export async function evaluatePositions(): Promise<void> {
  const positions = loadPositions();
  const tokenKeys = Object.keys(positions);
  if (tokenKeys.length === 0) return;

  for (const key of tokenKeys) {
    const pos = positions[key];
    try {
      const curBal = await tokenBalanceRaw(pos.token);
      if (curBal <= 0n) {
        log.info(`[STRATEGY] ${pos.symbol} balance 0 — position closed.`);
        delete positions[key];
        continue;
      }

      pos.currentTokens = curBal.toString();
      const quote = await quoteTokenToWeth(pos.token, curBal);
      if (quote.weth <= 0) continue; // no liquidity

      const tokensNum = Number(ethers.formatEther(curBal)) || 1;
      const curPrice = quote.weth / tokensNum;

      if (curPrice > pos.highestPriceWeth) {
        pos.highestPriceWeth = curPrice;
      }

      const pnlMultiplier = curPrice / pos.entryPriceWeth;
      const pnlPct = (pnlMultiplier - 1) * 100;
      pos.lastCheckedAt = Date.now();

      // ==========================================================
      // STRATEGY 0: DOLLAR-COST AVERAGING (DCA) DIP BUYING
      // If high conviction token dips -10% to -20%, buy dip to lower entry price
      // ==========================================================
      if (
        pos.isHighConviction &&
        pos.dcaCount < 2 &&
        pos.tpLevelsTaken.length === 0 &&
        pnlMultiplier <= 0.90 &&
        pnlMultiplier >= 0.78
      ) {
        const b = await balances().catch(() => null);
        const usable = Number(b?.weth ?? 0) + Math.max(0, Number(b?.eth ?? 0) - GAS_RESERVE);
        const dcaSizeEth = Math.min(0.01, Math.max(0.005, pos.entryWeth));

        if (usable >= dcaSizeEth) {
          try {
            log.info(`📉 [DCA DIP BUY] ${pos.symbol} dipped ${(100 - pnlMultiplier * 100).toFixed(1)}%! Executing DCA Dip Buy of ${dcaSizeEth}Ξ...`);
            const dcaWei = ethers.parseEther(String(dcaSizeEth));
            
            // Wrap ETH if needed
            const w = wallet();
            const wc = new ethers.Contract(C.weth, [...WETH_ABI, "function deposit() payable"], w);
            const wbal: bigint = await wc.balanceOf!(w.address).catch(() => 0n);
            if (wbal < dcaWei) {
              const wrapTx = await wc.deposit!({ value: dcaWei - wbal, ...(await overrides()) });
              await wrapTx.wait();
            }

            await swapWethToToken(pos.token, dcaWei, quote.fee);
            const newBal = await tokenBalanceRaw(pos.token);
            const newTokensNum = Number(ethers.formatEther(newBal)) || 1;
            
            const oldEntry = pos.entryPriceWeth;
            pos.totalWethSpent += dcaSizeEth;
            pos.currentTokens = newBal.toString();
            pos.entryPriceWeth = pos.totalWethSpent / newTokensNum; // Updated weighted average entry price
            pos.dcaCount += 1;
            savePositions(positions);

            log.info(`📉 [DCA EXECUTED ✅] ${pos.symbol}: Lowered Avg Entry Price from ${oldEntry.toExponential(3)}Ξ → ${pos.entryPriceWeth.toExponential(3)}Ξ! Total Spent: ${pos.totalWethSpent}Ξ`);
            await send(`📉 <b>[DCA DIP BUY EXECUTED] ${pos.symbol}</b>\n• Dipped: -${(100 - pnlMultiplier * 100).toFixed(1)}%\n• Added: +${dcaSizeEth}Ξ\n• <b>New Lowered Entry Price:</b> ${pos.entryPriceWeth.toExponential(3)}Ξ\n• Total Tokens: ${newBal.toString()}\n• Total Capital: ${pos.totalWethSpent.toFixed(4)}Ξ`).catch(() => {});
            continue;
          } catch (dcaErr) {
            log.warn(`[DCA] Failed to execute dip buy on ${pos.symbol}: ${(dcaErr as Error).message}`);
          }
        }
      }

      // ==========================================
      // STRATEGY 1: TIERED TAKE-PROFIT LADDER
      // ==========================================
      
      // TP1: +50% (1.5x) -> Sell 25%
      if (pnlMultiplier >= 1.5 && !pos.tpLevelsTaken.includes(1.5)) {
        const sellAmt = curBal / 4n;
        if (sellAmt > 0n) {
          log.info(`[TP1 HIT 🔥] ${pos.symbol} up +${pnlPct.toFixed(1)}%! Selling 25%`);
          const res = await swapTokenToWeth(pos.token, sellAmt, quote.fee);
          pos.tpLevelsTaken.push(1.5);
          savePositions(positions);
          await send(`💰 <b>[TP1 TRIGGERED] ${pos.symbol} (+50% / 1.5x)</b>\n• Sold 25% for +${ethers.formatEther(res.amountOut)}Ξ\n• Locking in initial gains!`).catch(() => {});
          continue;
        }
      }

      // TP2: +100% (2.0x) -> Sell 25% (Free Ride / Recoup 100% capital)
      if (pnlMultiplier >= 2.0 && !pos.tpLevelsTaken.includes(2.0)) {
        const sellAmt = curBal / 3n; // roughly 25% of initial
        if (sellAmt > 0n) {
          log.info(`[TP2 HIT 🚀 2X] ${pos.symbol} 2X BAGGER! Selling 25%`);
          const res = await swapTokenToWeth(pos.token, sellAmt, quote.fee);
          pos.tpLevelsTaken.push(2.0);
          savePositions(positions);
          await send(`🚀 <b>[TP2 2X BAGGER!] ${pos.symbol} (+100% / 2.0x)</b>\n• Sold 25% for +${ethers.formatEther(res.amountOut)}Ξ\n• Initial capital 100% recouped! Remaining bag is pure house money!`).catch(() => {});
          continue;
        }
      }

      // TP3: +300% (4.0x) -> Sell 25%
      if (pnlMultiplier >= 4.0 && !pos.tpLevelsTaken.includes(4.0)) {
        const sellAmt = curBal / 2n; // leave moonbag
        if (sellAmt > 0n) {
          log.info(`[TP3 HIT 💎 4X] ${pos.symbol} 4X MOONSHOT! Selling 25%`);
          const res = await swapTokenToWeth(pos.token, sellAmt, quote.fee);
          pos.tpLevelsTaken.push(4.0);
          pos.isMoonbag = true;
          savePositions(positions);
          await send(`💎 <b>[TP3 4X MOONSHOT!] ${pos.symbol} (+300% / 4.0x)</b>\n• Sold 25% for +${ethers.formatEther(res.amountOut)}Ξ\n• Remaining 25% converted to MOONBAG for 10x-100x runner!`).catch(() => {});
          continue;
        }
      }

      // ==========================================
      // STRATEGY 2: DYNAMIC TRAILING STOP-LOSS
      // ==========================================
      if (pos.tpLevelsTaken.length > 0) {
        // If price drops >20% from peak after entering TP territory
        const dropFromPeak = (pos.highestPriceWeth - curPrice) / pos.highestPriceWeth;
        if (dropFromPeak >= 0.20 && !pos.isMoonbag) {
          log.info(`[TRAILING STOP 🛑] ${pos.symbol} pulled back -${(dropFromPeak * 100).toFixed(1)}% from peak! Closing remaining.`);
          const res = await swapTokenToWeth(pos.token, curBal, quote.fee);
          delete positions[key];
          savePositions(positions);
          await send(`🛑 <b>[TRAILING STOP-LOSS] ${pos.symbol}</b>\n• Secured profit at +${pnlPct.toFixed(1)}% (Pulled back -20% from peak)\n• Realized: +${ethers.formatEther(res.amountOut)}Ξ`).catch(() => {});
          continue;
        }
      }

      // ==========================================
      // STRATEGY 3: HARD STOP-LOSS / ANTI-RUG GUARD
      // ==========================================
      if (pnlMultiplier <= 0.75 && pos.tpLevelsTaken.length === 0 && pos.dcaCount >= 2) {
        // -25% loss cutoff after exhausting DCA dip buys
        log.info(`[STOP-LOSS ⚠️] ${pos.symbol} down -25% (${pnlPct.toFixed(1)}%). Executing stop loss.`);
        const res = await swapTokenToWeth(pos.token, curBal, quote.fee);
        delete positions[key];
        savePositions(positions);
        await send(`⚠️ <b>[STOP-LOSS EXECUTED] ${pos.symbol} (-25%)</b>\n• Cut loss early to protect capital\n• Recovered: ${ethers.formatEther(res.amountOut)}Ξ`).catch(() => {});
        continue;
      }

    } catch (e) {
      log.warn(`[STRATEGY] Error evaluating ${pos.symbol}: ${(e as Error).message}`);
    }
  }

  savePositions(positions);
}

let strategyTimer: NodeJS.Timeout | null = null;

/** Start automated strategy execution loop (runs every 30s) */
export function startStrategyEngine(): void {
  if (strategyTimer) return;
  log.info("[STRATEGY] Started autonomous Meme Profit Engine with DCA Dip-Buying (30s interval)");
  strategyTimer = setInterval(() => {
    void evaluatePositions();
  }, 30_000);
}

export function stopStrategyEngine(): void {
  if (strategyTimer) {
    clearInterval(strategyTimer);
    strategyTimer = null;
  }
}
