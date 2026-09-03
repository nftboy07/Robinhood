/**
 * Persistent Blacklist & Honeypot Registry
 * In-memory cache for 0ms isBlacklisted checks on the hot path.
 */
import { dataPath, readJson, writeJson } from "../util/files.js";
import { logger } from "../util/log.js";

const log = logger("blacklist");
const BLACKLIST_FILE = dataPath("token-blacklist.json");

interface BlacklistStore {
  [tokenAddr: string]: {
    reason: string;
    symbol: string;
    blacklistedAt: number;
  };
}

let cache: BlacklistStore | null = null;

function load(): BlacklistStore {
  if (cache) return cache;
  cache = readJson<BlacklistStore>(BLACKLIST_FILE, {});
  return cache;
}

function save(b: BlacklistStore): void {
  cache = b;
  writeJson(BLACKLIST_FILE, b);
}

export function isBlacklisted(tokenAddr: string): boolean {
  return !!load()[tokenAddr.toLowerCase()];
}

export function addToBlacklist(tokenAddr: string, symbol: string, reason: string): void {
  const b = load();
  const key = tokenAddr.toLowerCase();
  if (!b[key]) {
    b[key] = { reason, symbol, blacklistedAt: Date.now() };
    save(b);
    log.info(`[BLACKLIST] Added ${symbol} (${tokenAddr}): ${reason}`);
  }
}
