/**
 * Persistent Blacklist & Honeypot Registry
 * Caches confirmed honeypots and high-tax scam tokens to skip them instantly (0ms latency).
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

function load(): BlacklistStore {
  return readJson<BlacklistStore>(BLACKLIST_FILE, {});
}

function save(b: BlacklistStore): void {
  writeJson(BLACKLIST_FILE, b);
}

export function isBlacklisted(tokenAddr: string): boolean {
  const b = load();
  return !!b[tokenAddr.toLowerCase()];
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
