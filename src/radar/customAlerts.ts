/**
 * Custom Multiplier & Price Alerts Engine
 * Allows setting target alert multipliers via Telegram command (/alert <symbol> <targetX>).
 */
import { dataPath, readJson, writeJson } from "../util/files.js";
import { logger } from "../util/log.js";

const log = logger("alerts");
const ALERTS_FILE = dataPath("custom-alerts.json");

export interface CustomAlert {
  symbol: string;
  targetMultiplier: number;
  createdAt: number;
  triggered: boolean;
}

function load(): CustomAlert[] {
  return readJson<CustomAlert[]>(ALERTS_FILE, []);
}

function save(a: CustomAlert[]): void {
  writeJson(ALERTS_FILE, a);
}

export function setCustomAlert(symbol: string, targetMultiplier: number): void {
  const alerts = load();
  const cleanSym = symbol.replace("$", "").toUpperCase();
  alerts.push({ symbol: cleanSym, targetMultiplier, createdAt: Date.now(), triggered: false });
  save(alerts);
  log.info(`[ALERT SET] Alert for $${cleanSym} at ${targetMultiplier}x`);
}

export function getActiveAlerts(): CustomAlert[] {
  return load().filter(a => !a.triggered);
}

export function markAlertTriggered(symbol: string, targetMultiplier: number): void {
  const alerts = load();
  for (const a of alerts) {
    if (a.symbol === symbol.toUpperCase() && a.targetMultiplier === targetMultiplier) {
      a.triggered = true;
    }
  }
  save(alerts);
}
