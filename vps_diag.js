#!/usr/bin/env node
/**
 * vps_diag.js - Run this on VPS for real output diagnostics without full bot.
 * Gives live chain data, config, etc.
 * Usage: node vps_diag.js
 */
require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');

const RPC = process.env.RPC || 'https://rpc.mainnet.chain.robinhood.com';
const provider = new ethers.JsonRpcProvider(RPC);

const CONFIG_PATH = 'config.json';
let config = {};
try { config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch {}

const PK = process.env.PK || '';
const wallet = PK ? new ethers.Wallet(PK, provider) : null;

(async () => {
  console.log('=== ROBINHOOD VPS REAL DIAGNOSTICS ===');
  console.log('Time:', new Date().toISOString());
  
  try {
    const net = await provider.getNetwork();
    const block = await provider.getBlockNumber();
    console.log(`Chain: ${net.chainId} | Block: ${block}`);
    console.log(`RPC: ${RPC}`);
  } catch (e) {
    console.log('RPC Error:', e.message);
  }

  if (wallet) {
    try {
      const bal = await provider.getBalance(wallet.address);
      console.log(`Wallet: ${wallet.address}`);
      console.log(`Balance: ${ethers.formatEther(bal)} ETH`);
    } catch (e) { console.log('Wallet balance error'); }
  } else {
    console.log('No PK in env - cannot show balance');
  }

  console.log('\n--- CONFIG ---');
  console.log('Snipe Amount:', config.snipeAmountEth || '0.0001');
  console.log('Factory set:', !!(config.factory && !config.factory.includes('REPLACE')));
  console.log('WETH set:', !!config.weth);
  console.log('Router set:', !!config.router);
  console.log('Poll ms:', config.pollIntervalMs || 800);

  console.log('\n--- POSITIONS ---');
  try {
    if (fs.existsSync('positions.json')) {
      const pos = JSON.parse(fs.readFileSync('positions.json'));
      console.log('Open positions file count:', pos.length);
      pos.slice(0,3).forEach((p,i) => console.log(`  ${i+1}. ${p.symbol || p.token}`));
    } else {
      console.log('No positions.json yet');
    }
  } catch {}

  console.log('\n--- .env check (keys only) ---');
  const envKeys = Object.keys(process.env).filter(k => k.includes('TELEGRAM') || k.includes('PK') || k.includes('ADMIN'));
  console.log('Relevant env vars present:', envKeys.join(', ') || 'none visible');

  console.log('\nRun "node robinhood_bot.js" or use PM2 for full live bot.');
  console.log('Use /diag in TG for similar live output.');
})();
