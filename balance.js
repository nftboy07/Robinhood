// balance.js — check the ArbExecutor contract and EOA wallet balances
import 'dotenv/config';
import { Wallet, formatEther } from 'ethers';
import { makeProvider } from './provider.js';

async function main() {
  const provider = await makeProvider();
  const wallet = process.env.PRIVATE_KEY ? new Wallet(process.env.PRIVATE_KEY, provider) : null;
  const executor = process.env.EXECUTOR_ADDR || null;

  console.log('=== RobinArb Balance Report ===');
  if (wallet) {
    const bal = await provider.getBalance(wallet.address);
    console.log(`Owner Wallet (EOA):  ${formatEther(bal)} ETH`);
  }
  if (executor) {
    const bal = await provider.getBalance(executor);
    console.log(`Arb Contract:        ${formatEther(bal)} ETH`);
  } else {
    console.log('No EXECUTOR_ADDR configured in .env');
  }
}
main().catch(console.error);
