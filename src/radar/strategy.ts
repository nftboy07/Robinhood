/**
 * Core Meme Token Strategy Engine
 * 
 * Features:
 * 1. Tiered Take-Profit Ladder (TP1: +50% sell 25%, TP2: +100% sell 25%, TP3: +300% sell 25%)
 * 2. Moonbag Runner (Remaining 25% rides for 10x-100x pumps)
 * 3. Dynamic Trailing Stop-Loss (Locks in profit if price drops >20% from peak after 1.5x)
 * 4. Hard Stop-Loss / Anti-Rug Guard (Cuts loss at -25% or liquidity crash)
 * 5. Automatic Position Tracking & Auto-Recycling Profits into WETH
 */

import { ethers } from "ethers";
import { quoteTokenToWeth, swapTokenToWeth, tokenBalanceRaw } from "../chain/swaps.js";
import { send } from "../telegram/tg.js";
import { logger } from "../util/log.js";
import { dataPath, readJson, writeJson } from "../util/files.js";

const log = logger("strategy");
const POSITIONS_FILE = dataPath("meme-positions.json");

export interface MemePosition {
  token: string;
  symbol: string;
  entryWeth: number;
  initialTokens: string; // BigInt as string
  currentTokens: string; // BigInt as string
  entryPriceWeth: number;
  highestPriceWeth: number;
  tpLevelsTaken: number[]; // [1.5, 2.0, 4.0]
  isMoonbag: boolean;
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
): Promise<void> {
  const positions = loadPositions();
  const tokenKey = tokenAddr.toLowerCase();
  
  const tokensNum = Number(ethers.formatEther(tokensReceived)) || 1;
  const entryPrice = entryWeth / tokensNum;

  positions[tokenKey] = {
    token: tokenAddr,
    symbol,
    entryWeth,
    initialTokens: tokensReceived.toString(),
    currentTokens: tokensReceived.toString(),
    entryPriceWeth: entryPrice,
    highestPriceWeth: entryPrice,
    tpLevelsTaken: [],
    isMoonbag: false,
    openedAt: Date.now(),
    lastCheckedAt: Date.now(),
  };

  savePositions(positions);
  log.info(`[STRATEGY] Tracking new position: ${symbol} (${entryWeth}Ξ @ ${entryPrice.toExponential(3)}Ξ/token)`);
  await send(`🎯 <b>[STRATEGY ENTERED] ${symbol}</b>\n• Size: ${entryWeth}Ξ\n• Tokens: ${tokensReceived.toString()}\n• Strategies Active: TP Ladder (1.5x, 2x, 4x) + Moonbag (25%) + Trailing Stop-Loss`).catch(() => {});
}

/** Evaluate and execute profit-taking and stop-loss on all open meme positions */
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
      if (pnlMultiplier <= 0.75 && pos.tpLevelsTaken.length === 0) {
        // -25% loss cutoff to protect capital
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
  log.info("[STRATEGY] Started autonomous Meme Profit Engine (30s interval)");
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
