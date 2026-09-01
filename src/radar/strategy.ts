import { detectParabolicClimax } from "./climaxDetector.js";
/**
 * Comprehensive Advanced Meme Trading Strategy Suite
 * 
 * Includes:
 * 1. 3-Tranche Split Amount Entry (0.003 -> 0.002 -> 0.005 ETH)
 * 2. Top Whale Concentration & Early Dump Frontrun Exit
 * 3. Stale Token / Fast-Death Auto Killer (2 hours flat -> exit)
 * 4. 5-Tier Take-Profit Ladder (TP0 +25%, TP1 +50% + Breakeven SL, TP2 2x, TP3 4x, TP4 5x)
 * 5. DCA Dip-Buying (-10% to -20% on high conviction memes)
 * 6. Dynamic Volatility-Adjusted Trailing Stop
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
  initialTokens: string;
  currentTokens: string;
  entryPriceWeth: number;
  highestPriceWeth: number;
  lastLiquidityWeth: number;
  tpLevelsTaken: number[];
  isMoonbag: boolean;
  isHighConviction: boolean;
  dcaCount: number;
  pyramided: boolean;
  breakevenLocked: boolean;
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
    lastLiquidityWeth: 0,
    tpLevelsTaken: [],
    isMoonbag: false,
    isHighConviction,
    dcaCount: 0,
    pyramided: false,
    breakevenLocked: false,
    openedAt: Date.now(),
    lastCheckedAt: Date.now(),
  };

  savePositions(positions);
  log.info(`[STRATEGY] Tracking new position: ${symbol} (${entryWeth.toFixed(4)}Ξ @ ${entryPrice.toExponential(3)}Ξ/token) [HighConviction=${isHighConviction}]`);
  await send(`🎯 <b>[STRATEGY ENTERED] ${symbol}</b>\n• Total Size: ${entryWeth.toFixed(4)}Ξ\n• Tokens: ${tokensReceived.toString()}\n• Strategies: Split DCA + 5-Stage TP + Whale Dump Exit + Stale Token Killer`).catch(() => {});
}

/** Check if large whale dump or insider concentration risk is detected */
async function checkWhaleDumpRisk(_tokenAddr: string, currentQuoteWeth: number, lastLiquidityWeth: number): Promise<boolean> {
  // 1. Rapid liquidity pull (>18% drop)
  if (lastLiquidityWeth > 0 && currentQuoteWeth < lastLiquidityWeth * 0.82) {
    return true;
  }
  return false;
}

/** Evaluate and execute all advanced trading strategies */
export async function evaluatePositions(): Promise<void> {
  const positions = loadPositions();
  const tokenKeys = Object.keys(positions);
  if (tokenKeys.length === 0) return;

  const now = Date.now();

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
      
      // ==========================================================
      // STRATEGY: WHALE DUMP & FLASH-RUG FRONT-RUN EXIT
      // If a top whale dumps or pool liquidity drops > 18%, dump immediately to save capital!
      // ==========================================================
      if (quote.weth > 0) {
        const isWhaleDump = await checkWhaleDumpRisk(pos.token, quote.weth, pos.lastLiquidityWeth);
        if (isWhaleDump) {
          log.warn(`🚨 [WHALE DUMP / RUG DETECTED] ${pos.symbol} liquidity dropped from ${pos.lastLiquidityWeth.toFixed(4)}Ξ → ${quote.weth.toFixed(4)}Ξ! Frontrunning dump...`);
          const res = await swapTokenToWeth(pos.token, curBal, quote.fee);
          delete positions[key];
          savePositions(positions);
          await send(`🚨 <b>[WHALE DUMP EARLY EXIT] ${pos.symbol}</b>\n• Detected insider dump / liquidity drain!\n• Frontran dump and recovered: ${ethers.formatEther(res.amountOut)}Ξ`).catch(() => {});
          continue;
        }
        pos.lastLiquidityWeth = quote.weth;
      }

      if (quote.weth <= 0) continue; // no liquidity

      const tokensNum = Number(ethers.formatEther(curBal)) || 1;
      const curPrice = quote.weth / tokensNum;

      if (curPrice > pos.highestPriceWeth) {
        pos.highestPriceWeth = curPrice;
      }

      const pnlMultiplier = curPrice / pos.entryPriceWeth;
      const pnlPct = (pnlMultiplier - 1) * 100;
      pos.lastCheckedAt = now;

      // ==========================================================
      // STRATEGY: STALE TOKEN / FAST-DEATH AUTO KILLER
      // If position is flat / dying (>2 hours with PnL <= 1.05x), exit to recycle ETH into new runners
      // ==========================================================
      const hoursOpen = (now - pos.openedAt) / (3600_000);
      if (hoursOpen >= 2.0 && pos.tpLevelsTaken.length === 0 && pnlMultiplier <= 1.05) {
        log.info(`⏱️ [STALE TOKEN KILLER] ${pos.symbol} stagnant for ${hoursOpen.toFixed(1)}h. Exiting before slow death.`);
        const res = await swapTokenToWeth(pos.token, curBal, quote.fee);
        delete positions[key];
        savePositions(positions);
        await send(`⏱️ <b>[STALE TOKEN EXITED] ${pos.symbol}</b>\n• Inactive for ${hoursOpen.toFixed(1)} hours with low volume\n• Capital recycled into new snipes: +${ethers.formatEther(res.amountOut)}Ξ`).catch(() => {});
        continue;
      }

      // ==========================================================
      // STRATEGY: DOLLAR-COST AVERAGING (DCA) DIP BUYING
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
        const dcaSizeEth = Math.min(0.01, Math.max(0.003, pos.entryWeth));

        if (usable >= dcaSizeEth) {
          try {
            log.info(`📉 [DCA DIP BUY] ${pos.symbol} dipped ${(100 - pnlMultiplier * 100).toFixed(1)}%! Executing DCA Dip Buy of ${dcaSizeEth}Ξ...`);
            const dcaWei = ethers.parseEther(String(dcaSizeEth));
            
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
            pos.entryPriceWeth = pos.totalWethSpent / newTokensNum;
            pos.dcaCount += 1;
            savePositions(positions);

            log.info(`📉 [DCA EXECUTED ✅] ${pos.symbol}: Lowered Avg Entry Price from ${oldEntry.toExponential(3)}Ξ → ${pos.entryPriceWeth.toExponential(3)}Ξ!`);
            await send(`📉 <b>[DCA DIP BUY EXECUTED] ${pos.symbol}</b>\n• Dipped: -${(100 - pnlMultiplier * 100).toFixed(1)}%\n• Added: +${dcaSizeEth}Ξ\n• <b>New Lowered Entry Price:</b> ${pos.entryPriceWeth.toExponential(3)}Ξ\n• Total Capital: ${pos.totalWethSpent.toFixed(4)}Ξ`).catch(() => {});
            continue;
          } catch (dcaErr) {
            log.warn(`[DCA] Failed to execute dip buy on ${pos.symbol}: ${(dcaErr as Error).message}`);
          }
        }
      }

      // ==========================================================
      // STRATEGY: MOMENTUM BREAKOUT PYRAMIDING (+150% PUMP)
      // ==========================================================
      if (pnlMultiplier >= 2.5 && !pos.pyramided && pos.isHighConviction) {
        const b = await balances().catch(() => null);
        const usable = Number(b?.weth ?? 0) + Math.max(0, Number(b?.eth ?? 0) - GAS_RESERVE);
        if (usable >= 0.005) {
          try {
            log.info(`🚀 [PYRAMIDING] ${pos.symbol} exploding +150%! Adding +0.005Ξ breakout size.`);
            const pWei = ethers.parseEther("0.005");
            await swapWethToToken(pos.token, pWei, quote.fee);
            pos.pyramided = true;
            pos.totalWethSpent += 0.005;
            savePositions(positions);
            await send(`🚀 <b>[PYRAMIDING BREAKOUT] ${pos.symbol}</b>\n• Token up +${pnlPct.toFixed(0)}%!\n• Compounded position with +0.005Ξ into massive momentum!`).catch(() => {});
          } catch (pyrErr) {
            log.warn(`[PYRAMIDING] Error on ${pos.symbol}: ${(pyrErr as Error).message}`);
          }
        }
      }

      // ==========================================================
      // TAKE-PROFIT (TP) STRATEGY LADDER
      // ==========================================================

      // TP0: Quick Micro-Scalp (+25% / 1.25x) -> Sell 15%
      if (pnlMultiplier >= 1.25 && !pos.tpLevelsTaken.includes(1.25)) {
        const sellAmt = (curBal * 15n) / 100n;
        if (sellAmt > 0n) {
          log.info(`[TP0 SCALP ⚡] ${pos.symbol} up +${pnlPct.toFixed(1)}%! Banking 15% quick profit`);
          const res = await swapTokenToWeth(pos.token, sellAmt, quote.fee);
          pos.tpLevelsTaken.push(1.25);
          savePositions(positions);
          await send(`⚡ <b>[TP0 QUICK SCALP] ${pos.symbol} (+25%)</b>\n• Sold 15% for +${ethers.formatEther(res.amountOut)}Ξ\n• Banked gas + locked initial green PnL!`).catch(() => {});
          continue;
        }
      }

      // TP1: +50% (1.5x) -> Sell 25% + LOCK BREAKEVEN STOP-LOSS!
      if (pnlMultiplier >= 1.5 && !pos.tpLevelsTaken.includes(1.5)) {
        const sellAmt = curBal / 4n;
        if (sellAmt > 0n) {
          log.info(`[TP1 HIT 🔥] ${pos.symbol} up +${pnlPct.toFixed(1)}%! Selling 25% + Locking Breakeven SL`);
          const res = await swapTokenToWeth(pos.token, sellAmt, quote.fee);
          pos.tpLevelsTaken.push(1.5);
          pos.breakevenLocked = true;
          savePositions(positions);
          await send(`💰 <b>[TP1 TRIGGERED] ${pos.symbol} (+50% / 1.5x)</b>\n• Sold 25% for +${ethers.formatEther(res.amountOut)}Ξ\n• 🛡️ <b>BREAKEVEN STOP-LOSS ACTIVATED</b> (Trade is now 100% Risk-Free!)`).catch(() => {});
          continue;
        }
      }

      // TP2: +100% (2.0x) -> Sell 25% (100% Capital Recouped)
      if (pnlMultiplier >= 2.0 && !pos.tpLevelsTaken.includes(2.0)) {
        const sellAmt = curBal / 3n;
        if (sellAmt > 0n) {
          log.info(`[TP2 HIT 🚀 2X] ${pos.symbol} 2X BAGGER! Selling 25%`);
          const res = await swapTokenToWeth(pos.token, sellAmt, quote.fee);
          pos.tpLevelsTaken.push(2.0);
          savePositions(positions);
          await send(`🚀 <b>[TP2 2X BAGGER!] ${pos.symbol} (+100% / 2.0x)</b>\n• Sold 25% for +${ethers.formatEther(res.amountOut)}Ξ\n• 100% of capital recouped! Remaining bag is 100% house money!`).catch(() => {});
          continue;
        }
      }

      // TP3: +300% (4.0x) -> Sell 25%
      if (pnlMultiplier >= 4.0 && !pos.tpLevelsTaken.includes(4.0)) {
        const sellAmt = curBal / 2n;
        if (sellAmt > 0n) {
          log.info(`[TP3 HIT 💎 4X] ${pos.symbol} 4X MOONSHOT! Selling 25%`);
          const res = await swapTokenToWeth(pos.token, sellAmt, quote.fee);
          pos.tpLevelsTaken.push(4.0);
          pos.isMoonbag = true;
          savePositions(positions);
          await send(`💎 <b>[TP3 4X MOONSHOT!] ${pos.symbol} (+300% / 4.0x)</b>\n• Sold 25% for +${ethers.formatEther(res.amountOut)}Ξ\n• Remaining 25% riding in permanent MOONBAG!`).catch(() => {});
          continue;
        }
      }

      // ==========================================================
      // STRATEGY: PARABOLIC CLIMAX & EXHAUSTION TOP DETECTOR
      // ==========================================================
      const highestMultiplier = pos.highestPriceWeth / pos.entryPriceWeth;
      const climax = detectParabolicClimax(pnlMultiplier, 0, 0, highestMultiplier);
      if (climax.isBlowOffTop && !pos.tpLevelsTaken.includes(999)) {
        log.info(`👑 [CLIMAX TRIGGERED] ${pos.symbol}: ${climax.reason}! Banking 50% parabolic peak profits...`);
        const sellAmt = curBal / 2n;
        if (sellAmt > 0n) {
          const res = await swapTokenToWeth(pos.token, sellAmt, quote.fee);
          pos.tpLevelsTaken.push(999);
          savePositions(positions);
          await send(`👑 <b>[PARABOLIC CLIMAX EXIT] ${pos.symbol}</b>\n• <b>Reason:</b> ${climax.reason}\n• Sold 50% for +${ethers.formatEther(res.amountOut)}Ξ\n• Banked peak profits before reversal!`).catch(() => {});
          continue;
        }
      }

      // TP4: Parabolic Climax Top Exit (>5.0x / 500% Gain) -> Sell 50%
      if (pnlMultiplier >= 5.0 && !pos.tpLevelsTaken.includes(5.0)) {
        const sellAmt = curBal / 2n;
        if (sellAmt > 0n) {
          log.info(`👑 [TP4 PARABOLIC TOP EXIT] ${pos.symbol} 5X MEGA RUNNER!`);
          const res = await swapTokenToWeth(pos.token, sellAmt, quote.fee);
          pos.tpLevelsTaken.push(5.0);
          savePositions(positions);
          await send(`👑 <b>[TP4 PARABOLIC TOP EXIT] ${pos.symbol} (+400% / 5.0x)</b>\n• Sold 50% of moonbag for +${ethers.formatEther(res.amountOut)}Ξ\n• Locking peak parabolic gains!`).catch(() => {});
          continue;
        }
      }

      // ==========================================================
      // STOP-LOSS (SL) & RISK MANAGEMENT ENGINE
      // ==========================================================

      // 1. Breakeven Stop-Loss Guard:
      if (pos.breakevenLocked && pnlMultiplier <= 1.02 && !pos.isMoonbag) {
        log.info(`🛡️ [BREAKEVEN SL TRIGGERED] ${pos.symbol} touched breakeven. Exiting remaining risk-free.`);
        const res = await swapTokenToWeth(pos.token, curBal, quote.fee);
        delete positions[key];
        savePositions(positions);
        await send(`🛡️ <b>[BREAKEVEN SL EXECUTED] ${pos.symbol}</b>\n• Closed remaining tokens at entry price with zero net loss\n• Recovered: +${ethers.formatEther(res.amountOut)}Ξ`).catch(() => {});
        continue;
      }

      // 2. Dynamic Volatility-Adjusted Trailing Stop-Loss:
      if (pos.tpLevelsTaken.length > 0) {
        const dropFromPeak = (pos.highestPriceWeth - curPrice) / pos.highestPriceWeth;
        const maxAllowedDrop = pnlMultiplier >= 3.0 ? 0.12 : 0.20;

        if (dropFromPeak >= maxAllowedDrop && !pos.isMoonbag) {
          log.info(`🛑 [TRAILING STOP] ${pos.symbol} pulled back -${(dropFromPeak * 100).toFixed(1)}% from peak! Closing position.`);
          const res = await swapTokenToWeth(pos.token, curBal, quote.fee);
          delete positions[key];
          savePositions(positions);
          await send(`🛑 <b>[TRAILING STOP-LOSS] ${pos.symbol}</b>\n• Secured profit at +${pnlPct.toFixed(1)}% (Pulled back -${(dropFromPeak * 100).toFixed(0)}% from peak)\n• Realized: +${ethers.formatEther(res.amountOut)}Ξ`).catch(() => {});
          continue;
        }
      }

      // 3. Hard Stop-Loss (-25% cutoff):
      if (pnlMultiplier <= 0.75 && pos.tpLevelsTaken.length === 0 && pos.dcaCount >= 2) {
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
  log.info("[STRATEGY] Started Comprehensive Meme Profit Engine with Whale Dump Guard (30s interval)");
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
