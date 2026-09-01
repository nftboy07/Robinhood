import { logger } from "../util/log.js";

const log = logger("poke-ai");
const POKE_API_KEY = process.env.POKE_API_KEY || "";
const POKE_URL = process.env.POKE_API_URL || "https://poke.com/api/v1/inbound/api-message";

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
      log.info(`[Poke AI] Subagent instruction dispatched: ${message.slice(0, 50)}...`);
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

/** Trigger Poke AI subagent swarm to scan Twitter/X & launchpads for Robinhood CA mentions */
export async function triggerPokeSubagentsScan(): Promise<void> {
  const prompt = "Scan Twitter/X and all Robinhood launchpads for new meme token CA mints and high-momentum contract addresses.";
  await sendPokeMessage(prompt);
}
