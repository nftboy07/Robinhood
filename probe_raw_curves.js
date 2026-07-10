const { ethers } = require('ethers');
const provider = new ethers.JsonRpcProvider('https://rpc.mainnet.chain.robinhood.com');
const FACTORY = '0xE7fC3eD1cCe4222047F07d4E58AF41C89Ac4A800';

async function main() {
  const data = ethers.id('curves(address)').slice(0, 10) + '000000000000000000000000ff685e3ae9ce589daac2e472d1a76df41ffe2bdd';
  const res = await provider.call({ to: FACTORY, data });
  console.log('Raw return:', res);
  
  const hex = res.slice(2);
  const len = Math.floor(hex.length / 64);
  console.log('Number of 32-byte chunks:', len);
  for(let i=0; i<len; i++) {
    const chunk = hex.slice(i*64, (i+1)*64);
    const val = BigInt('0x' + chunk);
    console.log(`  Chunk ${i}: 0x${chunk} (${val.toString()})`);
  }
}
main().catch(console.error);
