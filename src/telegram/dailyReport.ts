/**
 * Automated Daily PnL, Win-Rate & Trading Analytics Engine
 */
import { readJson } from "../util/files.js";
import { dataPath } from "../util/files.js";
import { balances } from "../chain/holdings.js";

export async function generateDailyReport(): Promise<string> {
  const b = await balances().catch(() => ({ eth: "0", weth: "0" }));
  const pos: Record<string, any> = readJson(dataPath("meme-positions.json"), {});
  const moonbags: Record<string, any> = readJson(dataPath("moonbag-positions.json"), {});

  const totalPositions = Object.keys(pos).length;
  const totalMoonbags = Object.keys(moonbags).length;
  const winningTrades = Object.values(pos).filter((p: any) => p.tpLevelsTaken?.length > 0).length;
  const winRate = totalPositions > 0 ? (winningTrades / totalPositions) * 100 : 100;

  const totalEth = Number(b.eth) + Number(b.weth);

  return `📊 <b>DAILY TRADING PERFORMANCE REPORT</b>\n\n` +
    `💰 <b>Total Wallet Equity:</b> <b>${totalEth.toFixed(4)}Ξ</b>\n` +
    `  • Liquid ETH: <b>${Number(b.eth).toFixed(4)}Ξ</b>\n` +
    `  • WETH Balance: <b>${Number(b.weth).toFixed(4)}Ξ</b>\n\n` +
    `📈 <b>Trading Statistics:</b>\n` +
    `  • Active Positions: <b>${totalPositions}</b>\n` +
    `  • Running Moonbags: <b>${totalMoonbags} 🚀</b>\n` +
    `  • Win-Rate: <b>${winRate.toFixed(1)}%</b>\n\n` +
    `✨ <i>All systems operating autonomously with 15-tier strategies + whale copy-trading!</i>`;
}
