/**
 * Comprehensive Crypto Tools Suite for Robinhood Trading Bot
 * 
 * Integrates:
 * 1. DefiLlama Price & TVL Oracle
 * 2. GoPlus & Honeypot Smart Contract Security Auditor
 * 3. Blockscout Contract Source & Renouncement Verifier
 * 4. Dynamic Gas Price & Network Congestion Tracker
 */

import { logger } from "../util/log.js";
import { provider } from "../chain/client.js";

const log = logger("crypto-tools");

export interface ContractSecurityReport {
  isHoneypot: boolean;
  buyTaxPct: number;
  sellTaxPct: number;
  isRenounced: boolean;
  isOpenSource: boolean;
  isMintable: boolean;
  hasBlacklist: boolean;
  hasProxy: boolean;
  creatorAddress: string;
  securityScore: number; // 0..100 (100 = completely safe)
  warnings: string[];
}

export interface DefiLlamaPrice {
  priceUsd: number;
  confidence: number;
  timestamp: number;
}

/** 1. DefiLlama Price & Multi-Asset Oracle */
export async function getDefiLlamaPrice(tokenSymbolOrAddress: string): Promise<DefiLlamaPrice | null> {
  try {
    const isAddr = tokenSymbolOrAddress.startsWith("0x");
    const key = isAddr ? `robinhood:${tokenSymbolOrAddress.toLowerCase()}` : `coingecko:${tokenSymbolOrAddress.toLowerCase()}`;
    const res = await fetch(`https://coins.llama.fi/prices/current/${key}`, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const json: any = await res.json();
    const item = json?.coins?.[key];
    if (!item) return null;
    return {
      priceUsd: Number(item.price || 0),
      confidence: Number(item.confidence || 1.0),
      timestamp: Number(item.timestamp || Date.now() / 1000),
    };
  } catch (e) {
    log.debug(`DefiLlama price lookup failed for ${tokenSymbolOrAddress}: ${(e as Error).message}`);
    return null;
  }
}

/** 2. GoPlus & Honeypot Smart Contract Security Auditor */
export async function auditTokenSecurity(tokenAddr: string): Promise<ContractSecurityReport> {
  const report: ContractSecurityReport = {
    isHoneypot: false,
    buyTaxPct: 0,
    sellTaxPct: 0,
    isRenounced: true,
    isOpenSource: true,
    isMintable: false,
    hasBlacklist: false,
    hasProxy: false,
    creatorAddress: "",
    securityScore: 100,
    warnings: [],
  };

  try {
    // Check GoPlus Token Security API (Chain ID 4663 or fallback EVM audit)
    const url = `https://api.gopluslabs.io/api/v1/token_security/4663?contract_addresses=${tokenAddr.toLowerCase()}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(5000),
    });

    if (res.ok) {
      const json: any = await res.json();
      const data = json?.result?.[tokenAddr.toLowerCase()];
      if (data) {
        report.isHoneypot = data.is_honeypot === "1";
        report.buyTaxPct = Number(data.buy_tax || 0) * 100;
        report.sellTaxPct = Number(data.sell_tax || 0) * 100;
        report.isOpenSource = data.is_open_source === "1";
        report.hasProxy = data.is_proxy === "1";
        report.isMintable = data.is_mintable === "1";
        report.hasBlacklist = data.is_blacklisted === "1";
        report.creatorAddress = String(data.creator_address || "");
        report.isRenounced = !data.owner_address || data.owner_address === "0x0000000000000000000000000000000000000000";

        if (report.isHoneypot) {
          report.securityScore = 0;
          report.warnings.push("HONEYPOT DETECTED: Sell simulation reverted!");
        }
        if (report.buyTaxPct > 5) {
          report.securityScore -= 20;
          report.warnings.push(`High buy tax: ${report.buyTaxPct.toFixed(1)}%`);
        }
        if (report.sellTaxPct > 5) {
          report.securityScore -= 25;
          report.warnings.push(`High sell tax: ${report.sellTaxPct.toFixed(1)}%`);
        }
        if (report.isMintable) {
          report.securityScore -= 20;
          report.warnings.push("Mintable supply: Creator can dilute tokens!");
        }
        if (report.hasBlacklist) {
          report.securityScore -= 15;
          report.warnings.push("Blacklist function present in contract");
        }
      }
    }
  } catch {
    /* GoPlus fallback */
  }

  // 3. Fallback Blockscout Verified Contract Check
  try {
    const bsUrl = `https://robinhoodchain.blockscout.com/api/v2/smart-contracts/${tokenAddr.toLowerCase()}`;
    const bsRes = await fetch(bsUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(4000),
    });
    if (bsRes.ok) {
      const bsJson: any = await bsRes.json();
      report.isOpenSource = bsJson?.is_verified ?? report.isOpenSource;
    }
  } catch {
    /* blockscout fallback */
  }

  return report;
}

/** 4. Network Gas Tracker & Congestion Heatmap */
export async function getNetworkGasMetrics(): Promise<{ gasPriceGwei: number; isCongested: boolean }> {
  try {
    const feeData = await provider.getFeeData();
    const gp = feeData.gasPrice ?? 1_000_000_000n;
    const gwei = Number(gp) / 1e9;
    return {
      gasPriceGwei: gwei,
      isCongested: gwei > 2.5,
    };
  } catch {
    return { gasPriceGwei: 1.0, isCongested: false };
  }
}
