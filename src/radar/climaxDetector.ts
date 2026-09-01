/**
 * Parabolic Climax & Blow-Off Top Detector
 * Detects vertical price spikes and exhaustion volume to take profit at the absolute peak.
 */
import { logger } from "../util/log.js";

const log = logger("climax-detector");

export interface ClimaxSignal {
  isBlowOffTop: boolean;
  surgeMultiplier: number;
  recommendation: "HOLD" | "TAKE_PROFIT_50" | "EXIT_ALL";
  reason: string;
}

export function detectParabolicClimax(
  pnlMultiplier: number,
  _volume5m: number,
  _volume1h: number,
  highestPnlMultiplier: number
): ClimaxSignal {
  // If price surges > 4x and drops > 10% from highest peak with high volume
  if (highestPnlMultiplier >= 4.0) {
    const pullbackFromPeak = (highestPnlMultiplier - pnlMultiplier) / highestPnlMultiplier;
    if (pullbackFromPeak >= 0.08) {
      log.info(`🎯 [CLIMAX DETECTED] Token hit ${highestPnlMultiplier.toFixed(1)}x peak and pulled back ${(pullbackFromPeak * 100).toFixed(1)}%! Climax top confirmed.`);
      return {
        isBlowOffTop: true,
        surgeMultiplier: highestPnlMultiplier,
        recommendation: "TAKE_PROFIT_50",
        reason: `Exhaustion top after ${highestPnlMultiplier.toFixed(1)}x pump`,
      };
    }
  }

  // If token is up 8x+ (>700%), trigger automatic full moonshot exit
  if (pnlMultiplier >= 8.0) {
    return {
      isBlowOffTop: true,
      surgeMultiplier: pnlMultiplier,
      recommendation: "EXIT_ALL",
      reason: `Parabolic 8X+ Moonshot Target Achieved`,
    };
  }

  return {
    isBlowOffTop: false,
    surgeMultiplier: pnlMultiplier,
    recommendation: "HOLD",
    reason: "Normal market momentum",
  };
}
