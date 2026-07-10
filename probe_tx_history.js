const { ethers } = require('ethers');
const provider = new ethers.JsonRpcProvider('https://rpc.mainnet.chain.robinhood.com');
const WALLET = '0x795c34b4991286711390c94705b4419d552f155f';

async function main() {
  const block = await provider.getBlockNumber();
  console.log('Current block:', block);

  // Let's scan recent txs by looking at the last few blocks or querying provider
  console.log('\nScanning recent blocks for wallet activity...');
  let checked = 0;
  for (let b = block; b > block - 1000; b--) {
    const blockData = await provider.getBlock(b, true);
    if (!blockData || !blockData.prefetchedTransactions) continue;
    checked++;
    for (const tx of blockData.prefetchedTransactions) {
      if (tx.from.toLowerCase() === WALLET.toLowerCase() || (tx.to && tx.to.toLowerCase() === WALLET.toLowerCase())) {
        console.log(`Block ${b} | Tx: ${tx.hash}`);
        console.log(`  From: ${tx.from}`);
        console.log(`  To:   ${tx.to}`);
        console.log(`  Val:  ${ethers.formatEther(tx.value)} ETH`);
        console.log(`  Data: ${tx.data.slice(0, 100)}`);
      }
    }
  }
  console.log(`Checked ${checked} blocks.`);
}

main().catch(console.error);
