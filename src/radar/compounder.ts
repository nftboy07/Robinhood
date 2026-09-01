/**
 * Automated Profit Compounder & Reinvestment Engine
 * Dynamically scales daily trading caps and sniping size as profits accumulate.
 */
import { balances } from "../chain/holdings.js";
import { cfg } from "../config.js";
import { logger } from "../util/log.js";

const log = logger("compounder");

export async function checkAndCompoundLimits(): Promise<void> {
  try {
    const b = await balances().catch(() => null);
    if (!b) return;

    const totalEth = Number(b.eth) + Number(b.weth);
    if (totalEth >= 0.20) {
      // Scale daily cap dynamically
      cfg.autoLp.dailyCapEth = Math.max(1.0, totalEth * 3);
      log.info(`📈 [COMPOUNDER] Total equity: ${totalEth.toFixed(4)}Ξ. Dynamically scaled Daily Cap to ${cfg.autoLp.dailyCapEth.toFixed(2)}Ξ!`);
    }
  } catch (e) {
    log.debug(`Compounder check failed: ${(e as Error).message}`);
  }
}

let compTimer: NodeJS.Timeout | null = null;

export function startCompounder(): void {
  if (compTimer) return;
  void checkAndCompoundLimits();
  compTimer = setInterval(() => {
    void checkAndCompoundLimits();
  }, 300_000); // Check every 5 minutes
}
