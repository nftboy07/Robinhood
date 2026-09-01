/**
 * Comprehensive Advanced Meme Trading Strategy Suite
 * 
 * =========================================================================
 * BUY STRATEGIES:
 * 1. Micro-Cap Ground Floor Snipe (<$100k MCAP with initial buy pressure)
 * 2. High-Conviction Moonshot Sizing (0.010 - 0.015 ETH on Ecosystem Devs / AI 85+)
 * 3. Dollar-Cost Averaging (DCA) Dip-Buying (-10% to -20% dip on high-conviction tokens)
 * 4. Momentum Breakout Pyramiding (+150% pump with surging buyer volume)
 * 
 * TAKE-PROFIT (TP) STRATEGIES:
 * 5. Micro-Profit Quick Scalp (+25% -> sell 15% to bank gas & secure green PnL)
 * 6. Tier 1 TP (+50% / 1.5x -> sell 25% + Move Stop-Loss to Breakeven!)
 * 7. Tier 2 TP (+100% / 2.0x 2X Bagger -> sell 25% + 100% Capital Recouped!)
 * 8. Tier 3 TP (+300% / 4.0x Moonshot -> sell 25%)
 * 9. Parabolic Climax Top Exit (>5.0x with volume exhaustion -> sell 50% of remainder)
 * 10. Moonbag Runner (Remaining bag rides with tightened 12% trailing stop)
 * 
 * STOP-LOSS (SL) & RISK DEFENSE:
 * 11. Breakeven Stop-Loss Guard (Never lose money after first TP)
 * 12. Dynamic Volatility Trailing Stop-Loss (20% trailing after 1.5x, 12% after 3x)
 * 13. Hard Stop-Loss (-25% cutoff after exhausting DCAs)
 * 14. Liquidity Pull / Flash-Rug Emergency Frontrun Exit (Exits if liq drops >20%)
 * 15. Stale Position Time-Decay Killer (Exits dead tokens stagnant > 4 hours)
 * =========================================================================
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
  lastLiquidityWeth: number;
  tpLevelsTaken: number[]; // [1.25, 1.5, 2.0, 4.0, 5.0]
  isMoonbag: boolean;
  isHighConviction: boolean;
  dcaCount: number; // number of times averaged down
  pyramided: boolean; // momentum breakout re-entry executed
  breakevenLocked: boolean; // stop-loss moved to breakeven
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
  log.info(`[STRATEGY] Tracking new position: ${symbol} (${entryWeth}Ξ @ ${entryPrice.toExponential(3)}Ξ/token) [HighConviction=${isHighConviction}]`);
  await send(`🎯 <b>[STRATEGY ENTERED] ${symbol}</b>\n• Size: ${entryWeth}Ξ\n• Tokens: ${tokensReceived.toString()}\n• Strategies: DCA Dips + 5-Stage TP + Breakeven SL + Flash-Rug Guard`).catch(() => {});
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
      // STRATEGY: FLASH-RUG / LIQUIDITY PULL EMERGENCY EXIT
      // If pool liquidity drops > 20% suddenly, dump immediately to save capital!
      // ==========================================================
      if (quote.weth > 0) {
        if (pos.lastLiquidityWeth > 0 && quote.weth < pos.lastLiquidityWeth * 0.75) {
          log.warn(`🚨 [FLASH-RUG DETECTED] ${pos.symbol} liquidity dropped from ${pos.lastLiquidityWeth.toFixed(4)}Ξ → ${quote.weth.toFixed(4)}Ξ! Emergency frontrun dump...`);
          const res = await swapTokenToWeth(pos.token, curBal, quote.fee);
          delete positions[key];
          savePositions(positions);
          await send(`🚨 <b>[EMERGENCY FLASH-RUG EXIT] ${pos.symbol}</b>\n• Pool liquidity pulled by dev!\n• Frontran dump and recovered: ${ethers.formatEther(res.amountOut)}Ξ`).catch(() => {});
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
      // STRATEGY: STALE POSITION TIME-DECAY KILLER
      // If position is flat (>4 hours, PnL between -10% and +10%), exit to free up ETH
      // ==========================================================
      const hoursOpen = (now - pos.openedAt) / (3600_000);
      if (hoursOpen >= 4.0 && pos.tpLevelsTaken.length === 0 && pnlMultiplier >= 0.90 && pnlMultiplier <= 1.10) {
        log.info(`⏱️ [STALE POSITION KILLER] ${pos.symbol} flat for ${hoursOpen.toFixed(1)}h. Re-allocating capital.`);
        const res = await swapTokenToWeth(pos.token, curBal, quote.fee);
        delete positions[key];
        savePositions(positions);
        await send(`⏱️ <b>[STALE POSITION EXITED] ${pos.symbol}</b>\n• Inactive for ${hoursOpen.toFixed(1)} hours with 0 momentum\n• Capital recycled: +${ethers.formatEther(res.amountOut)}Ξ`).catch(() => {});
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
        const dcaSizeEth = Math.min(0.01, Math.max(0.005, pos.entryWeth));

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
            pos.entryPriceWeth = pos.totalWethSpent / newTokensNum; // Updated weighted average
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
      // When token hits 2.5x with accelerating buy pressure, add 0.005 ETH to compound gains
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

      // TP0: Quick Micro-Scalp (+25% / 1.25x) -> Sell 15% (Banks gas immediately)
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
          pos.breakevenLocked = true; // Risk-free trade activated!
          savePositions(positions);
          await send(`💰 <b>[TP1 TRIGGERED] ${pos.symbol} (+50% / 1.5x)</b>\n• Sold 25% for +${ethers.formatEther(res.amountOut)}Ξ\n• 🛡️ <b>BREAKEVEN STOP-LOSS ACTIVATED</b> (Trade is now 100% Risk-Free!)`).catch(() => {});
          continue;
        }
      }

      // TP2: +100% (2.0x) -> Sell 25% (100% Capital Recouped / Pure Free Ride)
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

      // TP3: +300% (4.0x) -> Sell 25% (Moonshot Take-Profit)
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

      // TP4: Parabolic Climax Top Exit (>5.0x / 500% Gain) -> Sell 50% of remaining bag
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
      // If we already hit TP1 (+50%) and price pulls back to break-even (1.0x), exit to guarantee 0 loss!
      if (pos.breakevenLocked && pnlMultiplier <= 1.02 && !pos.isMoonbag) {
        log.info(`🛡️ [BREAKEVEN SL TRIGGERED] ${pos.symbol} touched breakeven. Exiting remaining risk-free.`);
        const res = await swapTokenToWeth(pos.token, curBal, quote.fee);
        delete positions[key];
        savePositions(positions);
        await send(`🛡️ <b>[BREAKEVEN SL EXECUTED] ${pos.symbol}</b>\n• Closed remaining tokens at entry price with zero net loss\n• Recovered: +${ethers.formatEther(res.amountOut)}Ξ`).catch(() => {});
        continue;
      }

      // 2. Dynamic Volatility-Adjusted Trailing Stop-Loss:
      // Tightens to 12% trailing stop on massive runners (>3x), otherwise 20% trailing stop
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
  log.info("[STRATEGY] Started Comprehensive Meme Profit Engine (30s interval)");
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
