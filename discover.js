#!/usr/bin/env node
/**
 * discover.js
 * Helper to find NOXA Fun / bonding curve contracts on Robinhood Chain (4663).
 *
 * Usage:
 *   node discover.js
 *
 * It:
 *  - Prints current block and chain info
 *  - Scans recent blocks for common creation / launch events (TokenCreated, PairCreated, etc.)
 *  - Tries to find high-activity contracts (likely factories)
 *  - Outputs candidate addresses for factory, router, WETH
 *
 * Then manually verify on Blockscout and update config.json
 */
require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');

const RPC = process.env.RPC || 'https://rpc.mainnet.chain.robinhood.com';
const provider = new ethers.JsonRpcProvider(RPC);

const COMMON_TOPICS = {
  // Common from prompt + real world
  TokenCreated: '0x6e6ae68e7d7d45fbd855c40d1eaafa8de46c5fbec3ee26f1af88730e400bc92c',
  PairCreated: ethers.id('PairCreated(address,address,address,uint256)'),
  // Add more if you reverse the ABI from site
};

async function main() {
  console.log('=== Robinhood Chain (4663) Discovery ===');
  const network = await provider.getNetwork();
  console.log('Chain ID:', network.chainId.toString());
  const current = await provider.getBlockNumber();
  console.log('Current block:', current);

  const LOOKBACK = 2000; // adjust for more history
  const fromBlock = Math.max(0, current - LOOKBACK);

  console.log(`\nScanning blocks ${fromBlock} → ${current} for launch-related events...`);

  // 1. Try known TokenCreated topic
  for (const [name, topic] of Object.entries(COMMON_TOPICS)) {
    try {
      const logs = await provider.getLogs({
        fromBlock,
        toBlock: current,
        topics: [topic]
      });
      console.log(`\n[${name}] logs found: ${logs.length}`);
      if (logs.length > 0) {
        const emitters = new Set();
        logs.slice(-10).forEach(l => {
          emitters.add(l.address);
          console.log(`  Emitter: ${l.address} | Tx: ${l.transactionHash} | Block: ${l.blockNumber}`);
        });
        console.log('  Unique emitters:', [...emitters]);
      }
    } catch (e) {
      console.log(`[${name}] scan error:`, e.message);
    }
  }

  // 2. Look for high-frequency "to" addresses in recent txs (potential factories/routers)
  console.log('\nAnalyzing recent transactions for high-activity contracts (possible launchpad)...');
  try {
    const block = await provider.getBlock(current, true); // include txs if supported
    const txs = block?.transactions || [];
    const counts = {};
    for (const tx of txs.slice(0, 50)) {
      if (tx.to) {
        counts[tx.to] = (counts[tx.to] || 0) + 1;
      }
    }
    const sorted = Object.entries(counts).sort((a,b) => b[1]-a[1]).slice(0, 10);
    console.log('Top interacted contracts in latest block sample:');
    sorted.forEach(([addr, cnt]) => console.log(`  ${addr}: ${cnt} txs`));
  } catch (e) {
    console.log('Block tx analysis limited (may need full tx objects or use explorer).');
  }

  // 3. Suggestions
  console.log('\n=== NEXT STEPS ===');
  console.log('1. Take the "Emitter" addresses above and paste into Blockscout.');
  console.log('2. Verify if they are the NOXA launch / bonding contract (look for create/launch functions + events).');
  console.log('3. For WETH: inspect any graduated token pair on explorer (Uniswap pairs).');
  console.log('4. For Router: look for swapExactTokensForETH calls on graduated tokens.');
  console.log('5. Update config.json with verified addresses.');
  console.log('6. Re-run with larger LOOKBACK or target a specific recent launch tx hash.');
  console.log('\nTip: Use browser devtools on fun.noxa.fi/robinhood while launching or buying to capture the exact "to" address.');
}

main().catch(console.error);
