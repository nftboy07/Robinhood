/**
 * Chart.zone Analytics & Terminal Integration
 * Platform: https://chart.zone
 * 
 * Provides live Chart.zone links, candle metrics, and volume radar for Robinhood Chain tokens.
 */

export interface ChartZoneMetrics {
  token: string;
  symbol: string;
  chartUrl: string;
  dexScreenerUrl: string;
  blockscoutUrl: string;
}

export function getChartZoneUrls(tokenAddress: string, symbol = "TOKEN"): ChartZoneMetrics {
  const addr = tokenAddress.toLowerCase();
  return {
    token: addr,
    symbol,
    chartUrl: `https://chart.zone/token/${addr}`,
    dexScreenerUrl: `https://dexscreener.com/robinhood/${addr}`,
    blockscoutUrl: `https://explorer.mainnet.chain.robinhood.com/token/${addr}`
  };
}

export function formatChartZoneHtml(tokenAddress: string, symbol: string): string {
  const urls = getChartZoneUrls(tokenAddress, symbol);
  return `🏰 <a href="https://robinhoodtrenches.com/token/${addr}">Trenches</a> | 📊 <a href="${urls.chartUrl}">Chart.zone</a> | 🦅 <a href="${urls.dexScreenerUrl}">DexScreener</a> | 🔍 <a href="${urls.blockscoutUrl}">Explorer</a>`;
}
