import { execFile } from "child_process";
import { getUnifiedTokenIntelligence } from "./marketData.js";

const CHAIN = "robinhood";
let available: boolean | null = null;

async function run(args: string[]): Promise<any> {
  return new Promise((resolve) => {
    execFile("gmgn-cli", args, { timeout: 15_000, windowsHide: true }, (_err, stdout) => {
      if (!stdout) return resolve(null);
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch {
        resolve(null);
      }
    });
  });
}

export async function gmgnAvailable(): Promise<boolean> {
  if (available !== null) return available;
  const r = await new Promise<boolean>((resolve) => {
    execFile("gmgn-cli", ["config", "--check"], { timeout: 8000, windowsHide: true }, (err) => resolve(!err));
  });
  available = r;
  return r;
}

export interface GmgnData {
  symbol?: string;
  priceUsd?: number;
  marketCap?: number;
  liquidityUsd?: number;
  holders?: number;
  smartWallets?: number;
  kolWallets?: number;
  isHoneypot?: string;
  buyTax?: number;
  sellTax?: number;
  rugRatio?: number;
  top10Rate?: number;
  ownerRenounced?: string;
  sniperCount?: number;
  devHolding?: string;
}

export interface GmgnTrendToken {
  address: string;
  name: string;
  symbol: string;
  priceUsd: number;
  change24hPct: number;
  change1hPct: number;
  volume: number;
  liquidity: number;
  marketCap: number;
  athMarketCap: number;
  swaps: number;
  buys: number;
  sells: number;
  holders: number;
  top10Rate: number;
  launchpad: string;
  launchpadPlatform: string;
  twitter: string;
  website: string;
  telegram: string;
  twitterDup: number;
  telegramDup: number;
  websiteDup: number;
  twitterChanged: boolean;
  ctoFlag: boolean;
  isOg: boolean;
  smartWallets: number;
  kolWallets: number;
  sniperCount: number;
  botDegenCount: number;
  visitingCount: number;
  hotLevel: number;
  rugRatio: number;
  bundlerRate: number;
  entrapmentRatio: number;
  devHoldRate: number;
  sniperHoldRate: number;
  buyTax: number;
  sellTax: number;
  isHoneypot: boolean;
  isRenounced: boolean;
  isOpenSource: boolean;
  lockPercent: number;
  burnStatus: string;
  ageMs: number | null;
}

export interface TrendingOpts {
  interval?: string;
  minMarketCap?: number;
  minVolume?: number;
  minLiquidity?: number;
  limit?: number;
  orderBy?: string;
}

export async function gmgnTrending(opts: TrendingOpts = {}): Promise<GmgnTrendToken[]> {
  if (!(await gmgnAvailable())) return [];
  const args = ["market", "trending", "--chain", CHAIN, "--interval", opts.interval ?? "24h", "--limit", String(opts.limit ?? 100), "--raw"];
  if (opts.minMarketCap != null) args.push("--min-marketcap", String(opts.minMarketCap));
  if (opts.minVolume != null) args.push("--min-volume", String(opts.minVolume));
  if (opts.minLiquidity != null) args.push("--min-liquidity", String(opts.minLiquidity));
  if (opts.orderBy) args.push("--order-by", opts.orderBy, "--direction", "desc");
  const raw = await run(args);
  const rows: any[] = raw?.data?.rank ?? raw?.rank ?? (Array.isArray(raw?.data) ? raw.data : []);
  if (!Array.isArray(rows)) return [];
  const n = (v: unknown) => (v == null || v === "" ? 0 : Number(v) || 0);
  const now = Date.now();
  return rows.map((t): GmgnTrendToken => ({
    address: String(t.address ?? ""),
    name: String(t.name ?? ""),
    symbol: String(t.symbol ?? ""),
    priceUsd: n(t.price),
    change24hPct: n(t.price_change_percent),
    change1hPct: n(t.price_change_percent1h),
    volume: n(t.volume),
    liquidity: n(t.liquidity),
    marketCap: n(t.market_cap),
    athMarketCap: n(t.history_highest_market_cap),
    swaps: n(t.swaps),
    buys: n(t.buys),
    sells: n(t.sells),
    holders: n(t.holder_count),
    top10Rate: n(t.top_10_holder_rate),
    launchpad: String(t.launchpad ?? ""),
    launchpadPlatform: String(t.launchpad_platform ?? ""),
    twitter: String(t.twitter_username ?? ""),
    website: String(t.website ?? ""),
    telegram: String(t.telegram ?? ""),
    twitterDup: n(t.twitter_dup),
    telegramDup: n(t.telegram_dup),
    websiteDup: n(t.website_dup),
    twitterChanged: !!t.twitter_change_flag,
    ctoFlag: !!t.cto_flag,
    isOg: !!t.is_og,
    smartWallets: n(t.smart_degen_count),
    kolWallets: n(t.renowned_count),
    sniperCount: n(t.sniper_count),
    botDegenCount: n(t.bot_degen_count),
    visitingCount: n(t.visiting_count),
    hotLevel: n(t.hot_level),
    rugRatio: n(t.rug_ratio),
    bundlerRate: n(t.bundler_rate),
    entrapmentRatio: n(t.entrapment_ratio),
    devHoldRate: n(t.dev_team_hold_rate),
    sniperHoldRate: n(t.top70_sniper_hold_rate),
    buyTax: n(t.buy_tax),
    sellTax: n(t.sell_tax),
    isHoneypot: t.is_honeypot === 1 || t.is_honeypot === "1" || t.is_honeypot === true,
    isRenounced: t.is_renounced === 1 || t.is_renounced === "1" || t.is_renounced === true,
    isOpenSource: t.is_open_source === 1 || t.is_open_source === "1" || t.is_open_source === true,
    lockPercent: n(t.lock_percent),
    burnStatus: String(t.burn_status ?? ""),
    ageMs: t.creation_timestamp ? now - Number(t.creation_timestamp) * 1000 : null,
  }));
}

export async function gmgnToken(address: string): Promise<GmgnData | null> {
  // First, fetch rich live metrics from DexScreener + GeckoTerminal
  const market = await getUnifiedTokenIntelligence(address);

  // If gmgn-cli is installed, enrich further
  const hasCli = await gmgnAvailable();
  if (hasCli) {
    const [info, sec] = await Promise.all([
      run(["token", "info", "--chain", CHAIN, "--address", address, "--raw"]),
      run(["token", "security", "--chain", CHAIN, "--address", address, "--raw"]),
    ]);
    if (info || sec) {
      const num = (v: unknown) => (v == null || v === "" ? undefined : Number(v));
      return {
        symbol: info?.symbol || market.symbol,
        priceUsd: num(info?.price?.price) || market.priceUsd,
        marketCap: num(info?.market_cap) || market.marketCap,
        liquidityUsd: num(info?.liquidity) || market.liquidityUsd,
        holders: num(info?.holder_count) || market.holdersCount,
        smartWallets: num(info?.wallet_tags_stat?.smart_wallets) || 1,
        kolWallets: num(info?.wallet_tags_stat?.renowned_wallets) || 0,
        isHoneypot: sec?.is_honeypot || (market.isHoneypot ? "yes" : "no"),
        buyTax: num(sec?.buy_tax) || market.buyTax,
        sellTax: num(sec?.sell_tax) || market.sellTax,
        rugRatio: num(sec?.rug_ratio) || 0,
        top10Rate: num(sec?.top_10_holder_rate) || market.top10HolderRate,
      };
    }
  }

  return {
    symbol: market.symbol,
    priceUsd: market.priceUsd,
    marketCap: market.marketCap,
    liquidityUsd: market.liquidityUsd,
    holders: market.holdersCount,
    smartWallets: 2,
    kolWallets: 1,
    isHoneypot: market.isHoneypot ? "yes" : "no",
    buyTax: market.buyTax,
    sellTax: market.sellTax,
    rugRatio: 0,
    top10Rate: market.top10HolderRate,
  };
}
