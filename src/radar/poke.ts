import { ethers } from "ethers";
import { provider } from "../chain/client.js";
import { ERC20_ABI } from "../chain/abis.js";
import { maybeAutoLp } from "./autolp.js";
import { send } from "../telegram/tg.js";
import { logger } from "../util/log.js";
import { dataPath, readJson, writeJson } from "../util/files.js";

const log = logger("poke-ai");
const POKE_API_KEY = process.env.POKE_API_KEY || "";
const POKE_URL = process.env.POKE_API_URL || "https://poke.com/api/v1/inbound/api-message";
const SEEN_CAS_FILE = dataPath("twitter-seen-cas.json");

export const CT_WATCHLIST = {
  // 1. Official Robinhood Chain Ecosystem (40 Accounts)
  robinhoodEcosystem: [
    "@Morpho", "@ponsdotfamily", "@bankrbot", "@ArtificiallyInu", "@cashcatfun",
    "@NetNetCap", "@arcus_xyz", "@Lighter_xyz", "@rialto_xyz", "@TheIndexFi",
    "@ClutchMarkets", "@Hookrfun", "@virtuals_io", "@prismassets", "@KarmaWallet",
    "@longdotxyz", "@ProjectVEXai", "@canopyfinance", "@deltaliquidity", "@pools_dot_fun",
    "@mobyagent", "@uponrh", "@isBacked_", "@ClawBankHQ", "@sherwoodagent",
    "@RamsesExchange", "@fablesfi", "@rallypadfun", "@ArrowFinanceio", "@L4VAprotocol",
    "@S_L_V_R_FUN", "@vantis_ai", "@grid_arena", "@letscashfun", "@longbowlend",
    "@JoinCtrlFi", "@robinscanio", "@hypdlaunch", "@gangswtf", "@xona_agent"
  ],

  // 2. Robinhood Meme Callers, Degens & Community Alpha Channels
  robinhoodMemeCallers: [
    "@RobinhoodMemes", "@RobinhoodDegens", "@RobinhoodAlpha", "@RHMemeAlerts",
    "@RobinhoodGems", "@RobinhoodDaily", "@RobinhoodHub", "@RHChainNews",
    "@RHChainGems", "@RH_ApeClub", "@RobinhoodEcosystem", "@RobinhoodWhales",
    "@RobinhoodCallers", "@RobinhoodDeFi", "@RobinhoodArmy", "@0xRobinhood",
    "@RobinhoodRadar", "@AlphaCallerRH", "@RH_Sniper", "@RobinhoodCalls",
    "@RobinhoodWhaleAlert", "@MemeGemsRH", "@RobinhoodGuru"
  ],

  // 3. Robinhood Native Launchpads & Bonding Curves
  robinhoodLaunchpads: [
    "@NoxaFun", "@FOMO_fund", "@ZeroHood_fun", "@O1_launch",
    "@RobinPump", "@RobinhoodLaunch", "@RH_MemePad", "@HoodSwap",
    "@RobinhoodDEX", "@SherwoodSwap"
  ],

  // 4. Top CT Meme Callers & Alpha Influencers
  topCtAlphas: [
    "@blknoiz06", "@theunipcs", "@MustStopMurad", "@ansem", "@Cobie",
    "@HsakaTrades", "@GCRClassic", "@cryptomanran", "@rektfencer", "@CrashiusClay69",
    "@0xSunMarket", "@cryptunez", "@CentrifugeCrypto", "@Defi_Made_Here", "@ThorHartvigsen",
    "@0xRamen", "@CryptoGorilla", "@MemeCoinGod", "@DegenSpartan", "@Tradermayne", "@SatoshiFlippa"
  ],

  // 5. CT On-Chain Whale Trackers & Intelligence Feeds
  whaleTrackers: [
    "@lookonchain", "@dexscreener", "@bubblemaps", "@gmgnai", "@DefiLlama",
    "@DuneAnalytics", "@whale_alert", "@ai_metadatabot", "@pepewhales", "@spotonchain"
  ],

  // 6. Crypto AI Agents & Key Leaders
  aiAndLeaders: [
    "@VladTenev", "@RobinhoodApp", "@VitalikButerin", "@HaydenZadler", "@shawmakesmagic",
    "@ai16zdao", "@truth_terminal", "@zerebro", "@clanker", "@pumpdotfun"
  ]
};

const ALL_ACCOUNTS = [
  ...CT_WATCHLIST.robinhoodEcosystem,
  ...CT_WATCHLIST.robinhoodMemeCallers,
  ...CT_WATCHLIST.robinhoodLaunchpads,
  ...CT_WATCHLIST.topCtAlphas,
  ...CT_WATCHLIST.whaleTrackers,
  ...CT_WATCHLIST.aiAndLeaders
];

function loadSeenCas(): Record<string, number> {
  return readJson<Record<string, number>>(SEEN_CAS_FILE, {});
}

function saveSeenCas(seen: Record<string, number>): void {
  writeJson(SEEN_CAS_FILE, seen);
}

/** Extract EVM 0x contract addresses from text */
export function extractCasFromText(text: string): string[] {
  const matches = text.match(/0x[a-fA-F0-9]{40}/g) || [];
  return Array.from(new Set(matches.map((a) => a.toLowerCase())));
}

/** Process a newly discovered CA from Twitter / CT / Poke AI */
export async function processTwitterCaCandidate(
  rawCa: string,
  author: string = "Robinhood Meme Caller",
  tweetSnippet: string = ""
): Promise<boolean> {
  const ca = rawCa.toLowerCase();
  const seen = loadSeenCas();
  if (seen[ca]) return false; // already evaluated

  seen[ca] = Date.now();
  saveSeenCas(seen);

  try {
    const code = await provider.getCode(ca);
    if (!code || code === "0x") return false; // not a contract

    const contract = new ethers.Contract(ca, ERC20_ABI, provider);
    const symbol: string = await contract.symbol!().catch(() => "");
    if (!symbol) return false; // not an ERC-20

    log.info(`🐦 [ROBINHOOD MEME CA FOUND] ${symbol} (${ca}) from ${author}`);
    await send(`🐦 <b>[ROBINHOOD MEME CA DETECTED]</b>\n• Token: <b>$${symbol}</b>\n• CA: <code>${ca}</code>\n• Source: <b>${author}</b>\n• Post: <i>${tweetSnippet.slice(0, 140)}</i>\n• Triggering instant automated position entry...`).catch(() => {});

    // Execute direct position buy
    const res = await maybeAutoLp(
      {
        token: ca,
        symbol,
        source: "poke-ai",
        wethSeed: 0.05,
        onchainBackPct: 100,
      },
      {
        llm: { score: 92, action: "ape", summary: `High conviction Robinhood meme call by ${author}` },
        gmgn: null,
      }
    );

    if (res?.opened) {
      log.info(`[Poke AI] Successfully took position in ${symbol} (${ca}) via Robinhood Meme alert!`);
      return true;
    }
    return false;
  } catch (e) {
    log.warn(`[Poke AI] Error processing CA ${ca}: ${(e as Error).message}`);
    return false;
  }
}

/** Send instruction / alert to Poke AI subagents pool */
export async function sendPokeMessage(message: string): Promise<string> {
  if (!POKE_API_KEY) {
    return "";
  }
  try {
    const res = await fetch(POKE_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${POKE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message }),
    });
    if (res.ok) {
      const respText = await res.text();
      return respText;
    }
    return "";
  } catch (e) {
    log.error(`[Poke AI] Error dispatching to subagents: ${(e as Error).message}`);
    return "";
  }
}

/** Trigger Poke AI subagents to scan Twitter/X for all Robinhood meme accounts & new CAs */
export async function scanTwitterRobinhoodMemes(): Promise<void> {
  const prompt = `Search live Twitter/X posts from all Robinhood meme mentioning accounts, callers, launchpads, and influencers (${ALL_ACCOUNTS.length} accounts including: ${ALL_ACCOUNTS.slice(0, 40).join(", ")}...). Find any newly announced Robinhood Chain contract addresses (0x...), meme tickers, and token drops.`;
  const responseText = await sendPokeMessage(prompt);

  if (responseText) {
    const cas = extractCasFromText(responseText);
    for (const ca of cas) {
      void processTwitterCaCandidate(ca, "Robinhood Meme Caller / Subagent", responseText);
    }
  }
}

let pokeInterval: NodeJS.Timeout | null = null;

/** Start automated background subagent polling loop (every 60s) */
export function startPokeSubagentWatcher(): void {
  if (pokeInterval) return;
  log.info(`[Poke AI] Started Subagent Watcher for ${ALL_ACCOUNTS.length} Robinhood Meme Accounts & Callers (60s loop)`);
  void scanTwitterRobinhoodMemes();
  pokeInterval = setInterval(() => {
    void scanTwitterRobinhoodMemes();
  }, 60_000);
}

export function stopPokeSubagentWatcher(): void {
  if (pokeInterval) {
    clearInterval(pokeInterval);
    pokeInterval = null;
  }
}
