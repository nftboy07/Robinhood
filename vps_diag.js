#!/usr/bin/env node
/**
 * vps_diag.js - Run this on VPS for real output diagnostics without full bot.
 * Gives live chain data, config, and actionable problem list.
 * Usage: node vps_diag.js
 */
require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');

const RPC = process.env.RPC || 'https://rpc.mainnet.chain.robinhood.com';
const provider = new ethers.JsonRpcProvider(RPC);

const CONFIG_PATH = 'config.json';
let config = {};
let configLoaded = false;
try {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  configLoaded = true;
} catch (e) {
  if (e.code !== 'ENOENT') console.log('config.json parse error:', e.message);
}

const PK = process.env.PK || '';
const wallet = PK && !PK.includes('YOUR') ? new ethers.Wallet(PK, provider) : null;

function isSet(val) {
  return !!(val && !String(val).includes('REPLACE'));
}

(async () => {
  console.log('=== ROBINHOOD VPS REAL DIAGNOSTICS ===');
  console.log('Time:', new Date().toISOString());

  const problems = [];

  try {
    const net = await provider.getNetwork();
    const block = await provider.getBlockNumber();
    console.log(`Chain: ${net.chainId} | Block: ${block}`);
    console.log(`RPC: ${RPC} (OK)`);
  } catch (e) {
    console.log('RPC Error:', e.message);
    problems.push('RPC unreachable — check network or try a backup RPC in config.rpcs');
  }

  if (!configLoaded) {
    problems.push('config.json missing — run: node setup.js (or copy config.json.example)');
  }

  if (!wallet) {
    problems.push('.env missing PK — add your wallet private key to .env');
  } else {
    try {
      const bal = await provider.getBalance(wallet.address);
      console.log(`Wallet: ${wallet.address}`);
      console.log(`Balance: ${ethers.formatEther(bal)} ETH`);
      if (parseFloat(ethers.formatEther(bal)) < 0.005) {
        problems.push('Wallet balance very low — fund wallet for gas + snipes');
      }
    } catch (e) {
      console.log('Wallet balance error');
      problems.push('Could not read wallet balance');
    }
  }

  const tgToken = process.env.TELEGRAM_TOKEN || process.env.BOT_TOKEN || '';
  const tgChat = process.env.ADMIN_CHAT_ID || process.env.TELEGRAM_CHAT_ID || '';
  if (!tgToken || tgToken.includes('123456789')) {
    problems.push('Telegram token missing in .env — alerts/commands will not work');
  }
  if (!tgChat) {
    problems.push('ADMIN_CHAT_ID missing in .env — Telegram bot cannot reach you');
  }

  console.log('\n--- CONFIG ---');
  console.log('Snipe Amount:', config.snipeAmountEth || '0.0001');
  console.log('Factory set:', isSet(config.factory));
  console.log('WETH set:', isSet(config.weth));
  console.log('Router set:', isSet(config.router));
  console.log('DEX Factory set:', isSet(config.dexFactory));
  console.log('Poll ms:', config.pollIntervalMs || 800);

  if (!isSet(config.factory)) {
    problems.push('factory not set — bot uses broad scan only (slower, may miss launches). Run node discover.js or node setup.js');
  }
  if (!isSet(config.weth) || !isSet(config.router)) {
    problems.push('weth/router not set — DEX sells after graduation will fail');
  }

  console.log('\n--- POSITIONS ---');
  try {
    if (fs.existsSync('positions.json')) {
      const pos = JSON.parse(fs.readFileSync('positions.json'));
      console.log('Open positions file count:', pos.length);
      pos.slice(0, 3).forEach((p, i) => console.log(`  ${i + 1}. ${p.symbol || p.token}`));
    } else {
      console.log('No positions.json yet');
    }
  } catch {}

  console.log('\n--- .env check (keys only) ---');
  const envKeys = Object.keys(process.env).filter(k => k.includes('TELEGRAM') || k.includes('PK') || k.includes('ADMIN') || k.includes('DEBANK'));
  console.log('Relevant env vars present:', envKeys.join(', ') || 'none visible');

  if (problems.length) {
    console.log('\n=== PROBLEMS FOUND ===');
    problems.forEach((p, i) => console.log(`${i + 1}. ${p}`));
    console.log('\nFix these, then: pm2 restart robinhood-sniper --update-env');
  } else {
    console.log('\n=== ALL CHECKS PASSED ===');
    console.log('Run "node robinhood_bot.js" or use PM2. Send /diag in Telegram to verify live.');
  }
})();
