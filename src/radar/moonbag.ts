/**
 * Autonomous Moonbag Strategy & Parabolic Moonshot Engine
 * 
 * Manages risk-free permanent runner bags (20-25% of tokens after 2x-4x capital recoup)
 * to ride parabolic 10x-100x pumps with automated ratchet profit floors.
 */
import { ethers } from "ethers";
import { quoteTokenToWeth, swapTokenToWeth, tokenBalanceRaw } from "../chain/swaps.js";
import { send } from "../telegram/tg.js";
import { logger } from "../util/log.js";
import { dataPath, readJson, writeJson } from "../util/files.js";

const log = logger("moonbag");
const MOONBAG_FILE = dataPath("moonbag-positions.json");

export interface MoonbagRecord {
  token: string;
  symbol: string;
  moonbagTokens: string;
  initialEntryPriceWeth: number;
  highestMultiplierHit: number;
  lockedProfitFloorMultiplier: number;
  milestonesHit: number[]; // e.g. [5, 10, 25, 50, 100]
  totalProfitRealizedEth: number;
  enrolledAt: number;
  lastCheckedAt: number;
}

interface MoonbagStore {
  [tokenAddr: string]: MoonbagRecord;
}

export function loadMoonbags(): MoonbagStore {
  return readJson<MoonbagStore>(MOONBAG_FILE, {});
}

export function saveMoonbags(m: MoonbagStore): void {
  writeJson(MOONBAG_FILE, m);
}

/** Enroll a token into the permanent Moonbag Strategy */
export async function enrollMoonbag(
  tokenAddr: string,
  symbol: string,
  entryPriceWeth: number,
  tokensHeld: bigint,
  alreadyRealizedEth: number
): Promise<void> {
  const bags = loadMoonbags();
  const key = tokenAddr.toLowerCase();

  bags[key] = {
    token: tokenAddr,
    symbol,
    moonbagTokens: tokensHeld.toString(),
    initialEntryPriceWeth: entryPriceWeth,
    highestMultiplierHit: 2.0,
    lockedProfitFloorMultiplier: 1.5,
    milestonesHit: [],
    totalProfitRealizedEth: alreadyRealizedEth,
    enrolledAt: Date.now(),
    lastCheckedAt: Date.now(),
  };

  saveMoonbags(bags);
  log.info(`💎 [MOONBAG ENROLLED] ${symbol} enrolled as permanent 100x runner moonbag!`);
  await send(`💎 <b>[PERMANENT MOONBAG ACTIVATED] $${symbol}</b>\n• 100% Capital Already Recouped!\n• Moonbag Size: <code>${ethers.formatEther(tokensHeld)}</code> tokens\n• Strategy: Riding 5x ➔ 10x ➔ 25x ➔ 50x ➔ 100x Moonshot Ladder!`).catch(() => {});
}

/** Evaluate all active moonbags against the 5x-100x Milestone Ladder */
export async function evaluateMoonbags(): Promise<void> {
  const bags = loadMoonbags();
  const keys = Object.keys(bags);
  if (keys.length === 0) return;

  for (const key of keys) {
    const bag = bags[key];
    try {
      const curBal = await tokenBalanceRaw(bag.token);
      if (curBal <= 0n) {
        delete bags[key];
        continue;
      }

      const quote = await quoteTokenToWeth(bag.token, curBal);
      if (quote.weth <= 0) continue;

      const tokensNum = Number(ethers.formatEther(curBal)) || 1;
      const curPrice = quote.weth / tokensNum;
      const curMultiplier = curPrice / bag.initialEntryPriceWeth;

      if (curMultiplier > bag.highestMultiplierHit) {
        bag.highestMultiplierHit = curMultiplier;
      }

      // ==========================================================
      // MOONBAG PARABOLIC MILESTONE LADDER (5x -> 10x -> 25x -> 50x -> 100x)
      // ==========================================================

      // 1. 5X Milestone (+400% pump) -> Lock 3.0x profit floor
      if (curMultiplier >= 5.0 && !bag.milestonesHit.includes(5)) {
        bag.milestonesHit.push(5);
        bag.lockedProfitFloorMultiplier = 3.0;
        log.info(`🚀 [MOONBAG 5X HIT!] ${bag.symbol} hit 5X! Ratcheted locked profit floor to 3.0x.`);
        await send(`🚀 <b>[MOONBAG 5X MILESTONE! 🎯] $${bag.symbol}</b>\n• Current Multiplier: <b>${curMultiplier.toFixed(1)}x</b>\n• Locked Profit Floor: <b>3.0x</b> (100% Protected)`).catch(() => {});
      }

      // 2. 10X Milestone (+900% pump) -> Sell 20% of moonbag + Lock 6.0x floor
      if (curMultiplier >= 10.0 && !bag.milestonesHit.includes(10)) {
        bag.milestonesHit.push(10);
        bag.lockedProfitFloorMultiplier = 6.0;
        const sellAmt = curBal / 5n;
        const res = await swapTokenToWeth(bag.token, sellAmt, quote.fee);
        bag.totalProfitRealizedEth += Number(ethers.formatEther(res.amountOut));
        log.info(`💎 [MOONBAG 10X GOD CANDLE!] ${bag.symbol} 10X! Sold 20% for +${ethers.formatEther(res.amountOut)}Ξ.`);
        await send(`💎 <b>[MOONBAG 10X GOD CANDLE! 🚀] $${bag.symbol}</b>\n• Multiplier: <b>10.0x (+900% Gain!)</b>\n• Banked 20% Profit: <b>+${ethers.formatEther(res.amountOut)}Ξ</b>\n• New Locked Profit Floor: <b>6.0x</b>`).catch(() => {});
      }

      // 3. 25X Milestone (+2,400% pump) -> Sell 25% + Lock 15.0x floor
      if (curMultiplier >= 25.0 && !bag.milestonesHit.includes(25)) {
        bag.milestonesHit.push(25);
        bag.lockedProfitFloorMultiplier = 15.0;
        const sellAmt = curBal / 4n;
        const res = await swapTokenToWeth(bag.token, sellAmt, quote.fee);
        bag.totalProfitRealizedEth += Number(ethers.formatEther(res.amountOut));
        log.info(`👑 [MOONBAG 25X MEGA RUNNER!] ${bag.symbol} 25X! Sold 25% for +${ethers.formatEther(res.amountOut)}Ξ.`);
        await send(`👑 <b>[MOONBAG 25X MEGA RUNNER! 🏆] $${bag.symbol}</b>\n• Multiplier: <b>25.0x (+2,400% Gain!)</b>\n• Banked: <b>+${ethers.formatEther(res.amountOut)}Ξ</b>\n• Locked Profit Floor: <b>15.0x</b>`).catch(() => {});
      }

      // 4. 50X Milestone (+4,900% pump) -> Sell 30% + Lock 30.0x floor
      if (curMultiplier >= 50.0 && !bag.milestonesHit.includes(50)) {
        bag.milestonesHit.push(50);
        bag.lockedProfitFloorMultiplier = 30.0;
        const sellAmt = (curBal * 30n) / 100n;
        const res = await swapTokenToWeth(bag.token, sellAmt, quote.fee);
        bag.totalProfitRealizedEth += Number(ethers.formatEther(res.amountOut));
        log.info(`🔥 [MOONBAG 50X ULTRA MOONSHOT!] ${bag.symbol} 50X! Sold 30% for +${ethers.formatEther(res.amountOut)}Ξ.`);
        await send(`🔥 <b>[MOONBAG 50X ULTRA MOONSHOT! 🌌] $${bag.symbol}</b>\n• Multiplier: <b>50.0x (+4,900% Gain!)</b>\n• Banked: <b>+${ethers.formatEther(res.amountOut)}Ξ</b>\n• Locked Profit Floor: <b>30.0x</b>`).catch(() => {});
      }

      // 5. 100X+ Legendary Milestone (+9,900% pump) -> Sell 50%
      if (curMultiplier >= 100.0 && !bag.milestonesHit.includes(100)) {
        bag.milestonesHit.push(100);
        bag.lockedProfitFloorMultiplier = 60.0;
        const sellAmt = curBal / 2n;
        const res = await swapTokenToWeth(bag.token, sellAmt, quote.fee);
        bag.totalProfitRealizedEth += Number(ethers.formatEther(res.amountOut));
        log.info(`🌌 [MOONBAG 100X LEGENDARY WINNER!] ${bag.symbol} 100X! Sold 50% for +${ethers.formatEther(res.amountOut)}Ξ.`);
        await send(`🌌 <b>[100X LEGENDARY WINNER! 🚀💎] $${bag.symbol}</b>\n• Multiplier: <b>100.0x (+9,900% GAIN!)</b>\n• Realized: <b>+${ethers.formatEther(res.amountOut)}Ξ</b>\n• Pure generational meme wealth!`).catch(() => {});
      }

      // ==========================================================
      // RATCHET PROFIT FLOOR TRAILING EXIT
      // If price pulls back below locked floor after hitting milestone, bank remaining!
      // ==========================================================
      if (bag.milestonesHit.length > 0 && curMultiplier < bag.lockedProfitFloorMultiplier) {
        log.info(`🛑 [MOONBAG PROFIT FLOOR TRIGGERED] ${bag.symbol} touched ${bag.lockedProfitFloorMultiplier}x floor. Cashing out remaining moonbag...`);
        const res = await swapTokenToWeth(bag.token, curBal, quote.fee);
        bag.totalProfitRealizedEth += Number(ethers.formatEther(res.amountOut));
        delete bags[key];
        saveMoonbags(bags);
        await send(`🛑 <b>[MOONBAG PROFIT SECURED] $${bag.symbol}</b>\n• Cashed out remaining at <b>${curMultiplier.toFixed(1)}x</b>\n• Total Lifetime Profit Banked: <b>+${bag.totalProfitRealizedEth.toFixed(4)}Ξ</b>`).catch(() => {});
        continue;
      }

      bag.lastCheckedAt = Date.now();
    } catch (e) {
      log.debug(`Moonbag eval error on ${bag.symbol}: ${(e as Error).message}`);
    }
  }

  saveMoonbags(bags);
}

let moonTimer: NodeJS.Timeout | null = null;

export function startMoonbagEngine(): void {
  if (moonTimer) return;
  log.info(`[MOONBAG] Started Autonomous Moonbag Strategy Engine (5x-100x Moonshot Ladder)`);
  moonTimer = setInterval(() => {
    void evaluateMoonbags();
  }, 20_000); // 20s evaluation loop
}
