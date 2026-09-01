import { logger } from "../util/log.js";

const log = logger("poke-ai");
const POKE_API_KEY = process.env.POKE_API_KEY || "";
const POKE_URL = process.env.POKE_API_URL || "https://poke.com/api/v1/inbound/api-message";

export const ROBINHOOD_ECOSYSTEM_ACCOUNTS = {
  mustWatch: [
    "@Morpho", "@ponsdotfamily", "@bankrbot", "@ArtificiallyInu", "@cashcatfun",
    "@NetNetCap", "@arcus_xyz", "@Lighter_xyz", "@rialto_xyz", "@TheIndexFi",
    "@ClutchMarkets", "@Hookrfun", "@virtuals_io"
  ],
  strongProjects: [
    "@prismassets", "@KarmaWallet", "@longdotxyz", "@ProjectVEXai", "@canopyfinance",
    "@deltaliquidity", "@pools_dot_fun", "@mobyagent", "@uponrh", "@isBacked_",
    "@ClawBankHQ", "@sherwoodagent", "@RamsesExchange", "@fablesfi"
  ],
  interesting: [
    "@rallypadfun", "@ArrowFinanceio", "@L4VAprotocol", "@S_L_V_R_FUN",
    "@vantis_ai", "@grid_arena", "@letscashfun"
  ],
  early: [
    "@longbowlend", "@JoinCtrlFi", "@robinscanio", "@hypdlaunch", "@gangswtf", "@xona_agent"
  ]
};

const ALL_ACCOUNTS = [
  ...ROBINHOOD_ECOSYSTEM_ACCOUNTS.mustWatch,
  ...ROBINHOOD_ECOSYSTEM_ACCOUNTS.strongProjects,
  ...ROBINHOOD_ECOSYSTEM_ACCOUNTS.interesting,
  ...ROBINHOOD_ECOSYSTEM_ACCOUNTS.early
];

export interface PokeAlert {
  token: string;
  symbol: string;
  source: "twitter" | "launchpad" | "telegram";
  rawMessage?: string;
}

/** Send instruction / alert to Poke AI subagents pool */
export async function sendPokeMessage(message: string): Promise<boolean> {
  if (!POKE_API_KEY) {
    log.debug("POKE_API_KEY missing");
    return false;
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
      log.info(`[Poke AI] Dispatched scan instruction for ${ALL_ACCOUNTS.length} ecosystem accounts`);
      return true;
    } else {
      log.warn(`[Poke AI] HTTP ${res.status}: ${await res.text()}`);
      return false;
    }
  } catch (e) {
    log.error(`[Poke AI] Error dispatching to subagents: ${(e as Error).message}`);
    return false;
  }
}

/** Trigger Poke AI subagent swarm to scan official Robinhood Ecosystem accounts for token launches */
export async function triggerPokeSubagentsScan(): Promise<void> {
  const prompt = `Monitor live Twitter/X posts, token launches, and contract drops from key Robinhood Chain ecosystem accounts: ${ALL_ACCOUNTS.join(", ")}. Detect newly deployed Robinhood Chain CAs (0x...), token tickers, and liquidity pools. Forward contract addresses immediately.`;
  await sendPokeMessage(prompt);
}

let pokeInterval: NodeJS.Timeout | null = null;

/** Start automated background subagent polling loop */
export function startPokeSubagentWatcher(): void {
  if (pokeInterval) return;
  log.info(`[Poke AI] Started subagent watcher for ${ALL_ACCOUNTS.length} Robinhood ecosystem accounts`);
  void triggerPokeSubagentsScan();
  // Poll every 3 minutes to keep subagent swarm active
  pokeInterval = setInterval(() => {
    void triggerPokeSubagentsScan();
  }, 180_000);
}

export function stopPokeSubagentWatcher(): void {
  if (pokeInterval) {
    clearInterval(pokeInterval);
    pokeInterval = null;
  }
}
