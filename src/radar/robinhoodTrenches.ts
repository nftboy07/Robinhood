/**
 * Robinhood Trenches (https://robinhoodtrenches.com/) Degen & Meme Radar
 * 
 * Tracks real-time trending tokens, caller signals, launchpad graduations,
 * and high-volume trench tokens on Robinhood Chain.
 */

import { send } from "../telegram/tg.js";
import { logger } from "../util/log.js";

const log = logger("trenches");

export function getTrenchesTokenUrl(tokenAddress: string): string {
  return `https://robinhoodtrenches.com/token/${tokenAddress.toLowerCase()}`;
}

export function getTrenchesHomeUrl(): string {
  return "https://robinhoodtrenches.com/";
}

export function formatTrenchesLinksHtml(tokenAddress: string, symbol = "TOKEN"): string {
  const addr = tokenAddress.toLowerCase();
  return `🏰 <a href="${getTrenchesTokenUrl(addr)}">Robinhood Trenches</a> | 📊 <a href="https://chart.zone/token/${addr}">Chart.zone</a> | 🦅 <a href="https://dexscreener.com/robinhood/${addr}">DexScreener</a>`;
}

export async function handleTrenchesCommand(): Promise<void> {
  try {
    const msg = 
      `🏰 <b>[ROBINHOOD TRENCHES — DEGEN & MEME RADAR ⚔️]</b>\n\n` +
      `Live Robinhood Chain token screener, caller leaderboard & trench terminal.\n\n` +
      `• <b>Platform URL:</b> <a href="https://robinhoodtrenches.com/">https://robinhoodtrenches.com/</a>\n` +
      `• <b>Features:</b>\n` +
      `  ├ 🚀 <b>Trending Trenches:</b> Real-time bonding curve graduations & volume spikes\n` +
      `  ├ 📢 <b>Caller Alpha:</b> Top Robinhood Chain influencer & degen caller picks\n` +
      `  ├ ⚡ <b>Instant Terminal:</b> Direct token inspect & on-chain contract audits\n` +
      `  └ 🎯 <b>Bot Sync:</b> 0ms Quad-Factory anti-MEV snipes on all trending trench tokens!\n\n` +
      `🔗 <b>Explore Trenches:</b> <a href="https://robinhoodtrenches.com/">Open Robinhood Trenches Live</a>`;
    await send(msg);
  } catch (e) {
    log.error(`Trenches command error: ${(e as Error).message}`);
    await send(`❌ Error loading Trenches: ${(e as Error).message}`);
  }
}
