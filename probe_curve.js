const { ethers } = require('ethers');
const provider = new ethers.JsonRpcProvider('https://rpc.mainnet.chain.robinhood.com');
const FACTORY = '0xE7fC3eD1cCe4222047F07d4E58AF41C89Ac4A800';
const EVENT_TOPIC = '0x6e6ae68e7d7d45fbd855c40d1eaafa8de46c5fbec3ee26f1af88730e400bc92c';

async function main() {
  const block = await provider.getBlockNumber();
  const logs = await provider.getLogs({
    fromBlock: block - 50000,
    toBlock: block,
    address: FACTORY,
    topics: [EVENT_TOPIC]
  });

  console.log('Found', logs.length, 'TokenCreated events\n');

  for (const log of logs) {
    console.log('--- Event ---');
    console.log('Block:', log.blockNumber);
    console.log('TxHash:', log.transactionHash);
    console.log('Topics count:', log.topics.length);
    log.topics.forEach((t, i) => console.log(`  topics[${i}]:`, t));
    console.log('Data length:', log.data.length);
    console.log('Data:', log.data);

    // Try to decode data as addresses (32-byte aligned)
    if (log.data && log.data.length > 2) {
      const dataHex = log.data.slice(2);
      const chunks = Math.floor(dataHex.length / 64);
      console.log('Data chunks:', chunks);
      for (let i = 0; i < chunks; i++) {
        const chunk = dataHex.slice(i * 64, (i+1) * 64);
        const asAddr = '0x' + chunk.slice(-40);
        const asBigInt = BigInt('0x' + chunk);
        console.log(`  chunk[${i}]: 0x${chunk}`);
        if (chunk.startsWith('000000000000000000000000')) {
          console.log(`          -> addr: ${asAddr}`);
        } else {
          console.log(`          -> uint: ${asBigInt.toString()}`);
        }
      }
    }

    // Fetch the tx to see who was called and with what
    const tx = await provider.getTransaction(log.transactionHash);
    console.log('Tx from:', tx.from);
    console.log('Tx to (factory):', tx.to);
    console.log('Tx value:', ethers.formatEther(tx.value), 'ETH');
    console.log('Tx data (first 200 chars):', tx.data.slice(0, 200));

    // Try to get the deployed curve address from the tx receipt
    const receipt = await provider.getTransactionReceipt(log.transactionHash);
    console.log('Receipt contractAddress:', receipt.contractAddress);
    console.log('Logs in receipt:', receipt.logs.length);

    // Find contracts deployed in this tx (to=null means contract creation)
    for (const rlog of receipt.logs) {
      if (rlog.address.toLowerCase() !== FACTORY.toLowerCase()) {
        const code = await provider.getCode(rlog.address);
        if (code.length > 2) {
          console.log('  Other contract with code:', rlog.address, '(' + rlog.address.length + ' chars)');
        }
      }
    }
    console.log('');
  }
}

main().catch(console.error);
