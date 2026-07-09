const { ethers } = require('ethers');
const provider = new ethers.JsonRpcProvider('https://rpc.mainnet.chain.robinhood.com');

const FACTORY = '0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f';
const WETH_CANDIDATE = '0xc6911796042b15d7fa4f6cde69e245ddcd3d9c31';

async function scan() {
  const current = await provider.getBlockNumber();

  // 1. Verify WETH candidate by checking name/symbol
  const erc20Abi = ['function name() view returns (string)', 'function symbol() view returns (string)', 'function decimals() view returns (uint8)'];
  const weth = new ethers.Contract(WETH_CANDIDATE, erc20Abi, provider);
  const [wethName, wethSym] = await Promise.all([weth.name().catch(() => '?'), weth.symbol().catch(() => '?')]);
  console.log('WETH candidate:', WETH_CANDIDATE, '| Name:', wethName, '| Symbol:', wethSym);

  // 2. Get first pair from factory to find a sample pair
  const factoryAbi = ['function allPairs(uint256) view returns (address)', 'function allPairsLength() view returns (uint256)'];
  const factory = new ethers.Contract(FACTORY, factoryAbi, provider);
  const pairLen = await factory.allPairsLength();
  console.log('Factory', FACTORY, '| Total pairs:', pairLen.toString());

  // Get the last pair
  const lastPair = await factory.allPairs(pairLen - 1n);
  console.log('Last pair address:', lastPair);

  // 3. Try to find router by looking at transactions to pairs
  // The router is whatever address called the pair's swap
  const pairAbi = ['function token0() view returns (address)', 'function token1() view returns (address)'];
  const pairContract = new ethers.Contract(lastPair, pairAbi, provider);
  const [t0, t1] = await Promise.all([pairContract.token0(), pairContract.token1()]);
  console.log('Last pair tokens:', t0, '/', t1);

  // Get recent txs to this pair to find router
  const swapTopic = ethers.id('Swap(address,uint256,uint256,uint256,uint256,address)');
  const swapLogs = await provider.getLogs({ fromBlock: current - 200, toBlock: current, address: lastPair, topics: [swapTopic] }).catch(() => []);
  console.log('\nRecent Swap events on last pair:', swapLogs.length);

  const routers = new Set();
  for (const log of swapLogs.slice(0, 5)) {
    const tx = await provider.getTransaction(log.transactionHash).catch(() => null);
    if (tx) {
      console.log('  Swap caller/router:', tx.to, '| from:', tx.from);
      if (tx.to) routers.add(tx.to);
    }
  }

  // 4. Scan ALL pairs for swap events to find router
  console.log('\n--- Scanning multiple pairs for router ---');
  for (let i = Math.max(0, Number(pairLen) - 5); i < Number(pairLen); i++) {
    const pair = await factory.allPairs(BigInt(i));
    const swaps = await provider.getLogs({ fromBlock: current - 500, toBlock: current, address: pair, topics: [swapTopic] }).catch(() => []);
    for (const log of swaps.slice(0, 2)) {
      const tx = await provider.getTransaction(log.transactionHash).catch(() => null);
      if (tx && tx.to) {
        routers.add(tx.to);
        console.log('  Router candidate:', tx.to, '(from pair', pair, ')');
      }
    }
  }

  // 5. Launchpad factory scan - wider range
  console.log('\n--- Launchpad factory scan (wider: 20000 blocks) ---');
  const tokenTopic = '0x6e6ae68e7d7d45fbd855c40d1eaafa8de46c5fbec3ee26f1af88730e400bc92c';
  const tokens = await provider.getLogs({ fromBlock: current - 20000, toBlock: current, topics: [tokenTopic] }).catch(e => { console.log('getLogs err:', e.message); return []; });
  console.log('TokenCreated logs in 20k blocks:', tokens.length);
  const launchFactories = new Set();
  tokens.forEach(l => {
    launchFactories.add(l.address);
    const token = '0x' + l.topics[1].slice(-40);
    const curve = l.topics[2] ? '0x' + l.topics[2].slice(-40) : 'N/A';
    console.log('  Factory:', l.address, '| token:', token, '| curve:', curve);
  });

  console.log('\n=== FINAL ADDRESSES ===');
  console.log('WETH:    ', WETH_CANDIDATE, '(' + wethSym + ')');
  console.log('DEX Factory:', FACTORY);
  console.log('Router:', [...routers].join(', ') || 'not found - need live swap');
  console.log('Launchpad Factory:', [...launchFactories].join(', ') || 'not found in 20k blocks');
}

scan().catch(e => console.error('Error:', e.message));
