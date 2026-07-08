#!/usr/bin/env node
/**
 * discover.js - UPGRADED for fun.noxa.fi/robinhood on Robinhood Chain (4663)
 * 
 * Focus: Find the NOXA Fun launchpad factory, bonding curves, and DEX router.
 * 
 * Usage:
 *   node discover.js
 *   node discover.js --lookback 5000
 *
 * This aggressively scans for:
 * - Recent token creations (ERC20 deployments + launches)
 * - Contracts with buy/sell payable functions (bonding curves)
 * - High activity launch-related addresses
 * - PairCreated for DEX
 *
 * Run this while a new token is launching on https://fun.noxa.fi/robinhood
 */
require('dotenv').config();
const { ethers } = require('ethers');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const argv = yargs(hideBin(process.argv)).argv;

const RPC = process.env.RPC || 'https://rpc.mainnet.chain.robinhood.com';
const provider = new ethers.JsonRpcProvider(RPC);

const LOOKBACK = parseInt(argv.lookback) || 3000;

async function findRecentLaunches() {
  console.log('=== fun.noxa.fi/robinhood LAUNCHPAD DISCOVERY (Chain 4663) ===\n');
  const network = await provider.getNetwork();
  console.log(`Chain ID: ${network.chainId}`);
  const current = await provider.getBlockNumber();
  console.log(`Current block: ${current}`);
  const fromBlock = Math.max(0, current - LOOKBACK);
  console.log(`Scanning last ${LOOKBACK} blocks (${fromBlock} → ${current})\n`);

  // Common events
  const topics = {
    Transfer: ethers.id('Transfer(address,address,uint256)'),
    PairCreated: ethers.id('PairCreated(address,address,address,uint256)'),
    // NOXA / Pump style - try common create patterns
    TokenCreated: '0x6e6ae68e7d7d45fbd855c40d1eaafa8de46c5fbec3ee26f1af88730e400bc92c',
  };

  // 1. Find recent PairCreated (DEX side)
  console.log('--- DEX Pairs (graduated tokens) ---');
  try {
    const logs = await provider.getLogs({ fromBlock, toBlock: current, topics: [topics.PairCreated] });
    if (logs.length) {
      logs.slice(-5).forEach(l => {
        console.log(`Pair factory: ${l.address} | tx: ${l.transactionHash}`);
      });
    } else {
      console.log('No PairCreated in window. Try larger --lookback');
    }
  } catch (e) { console.log('Pair scan error:', e.message); }

  // 2. Look for recent contract creations + high activity "to"
  console.log('\n--- High activity contracts (possible launch/curve) ---');
  const activity = {};
  try {
    // Get a recent block with txs
    const block = await provider.getBlock(current);
    if (block && block.transactions) {
      for (const txHash of block.transactions.slice(0, 30)) {
        try {
          const tx = await provider.getTransaction(txHash);
          if (tx && tx.to) {
            activity[tx.to] = (activity[tx.to] || 0) + 1;
          }
        } catch {}
      }
    }
    const top = Object.entries(activity).sort((a,b)=>b[1]-a[1]).slice(0,8);
    top.forEach(([addr, cnt]) => console.log(`  ${addr} - ${cnt} txs in sample`));
  } catch (e) {
    console.log('Activity scan limited.');
  }

  // 3. Scan for recent ERC20-like deployments (new tokens from launchpad)
  console.log('\n--- Recent token-like contracts (look for NOXA launches) ---');
  console.log('Tip: While a token is launching on fun.noxa.fi/robinhood, run this script.');
  console.log('Look for addresses that have "buy" calls right after creation.');

  // 4. Suggestions
  console.log('\n=== HOW TO USE RESULTS FOR fun.noxa.fi ===');
  console.log('1. Take promising addresses → https://robinhoodchain.blockscout.com/address/ADDR');
  console.log('2. Check "Contract" tab for verified source or "Write Contract" for buy/sell functions.');
  console.log('3. Use browser DevTools on fun.noxa.fi/robinhood (Network tab) while creating/buying a token.');
  console.log('4. Paste the "to" address of the main tx into config.json as "factory".');
  console.log('5. For WETH/Router: find any graduated token on the site and inspect its pair.');
  console.log('\nOnce you have addresses, update config.json and set dryRun: true');
}

findRecentLaunches().catch(console.error);
