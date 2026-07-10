const fs = require('fs');
let src = fs.readFileSync('./robinhood_bot.js', 'utf8');

const CRLF = '\r\n';

const oldSellOnDex = `// Sell on DEX (Uniswap V2 style) after migration
async function sellOnDex(tokenAddress, tokenAmount) {
  if (!ROUTER || !WETH) {
    logger.warn('No ROUTER/WETH configured - cannot sell on DEX. Update config.json with real addresses.');
    return null;
  }
  try {
    // 1. Approve router if needed
    const erc20ABI = [
      'function allowance(address owner, address spender) external view returns (uint256)',
      'function approve(address spender, uint256 amount) external returns (bool)'
    ];
    const tokenContract = new ethers.Contract(tokenAddress, erc20ABI, wallet);
    const allowance = await tokenContract.allowance(wallet.address, ROUTER).catch(() => 0n);
    if (allowance < tokenAmount) {
      logger.info(\`Approving router to spend \${tokenAddress}...\`);
      await sendTg(\`\u2699\ufe0f Approving DEX router to spend \${tokenAddress}...\`);
      const approveTx = await tokenContract.approve(ROUTER, ethers.MaxUint256, { gasLimit: 100000 });
      await approveTx.wait();
      logger.info('Approval successful.');
    }

    const router = new ethers.Contract(ROUTER, routerABI, wallet);
    const path = [tokenAddress, WETH];
    const deadline = Math.floor(Date.now() / 1000) + 300;

    // 2. Dynamic slippage check using getAmountsOut
    let minOut = 0n;
    try {
      const amounts = await router.getAmountsOut(tokenAmount, path);
      if (amounts && amounts.length >= 2) {
        const expectedOut = amounts[1];
        minOut = expectedOut * BigInt(100 - SLIPPAGE_PCT) / 100n;
        logger.info(\`DEX amountsOut expected: \${ethers.formatEther(expectedOut)} ETH | minOut (with slippage): \${ethers.formatEther(minOut)} ETH\`);
      }
    } catch (e) {
      logger.warn('Failed to estimate DEX amountsOut for slippage: ' + e.message);
    }

    const tx = await router.swapExactTokensForETHSupportingFeeOnTransferTokens(
      tokenAmount,
      minOut,
      path,
      wallet.address,
      deadline,
      { gasLimit: 600000 }
    );
    const receipt = await tx.wait();
    const txHash = receipt.hash || receipt.transactionHash;
    logger.info(\`[DEX SELL] \${tokenAddress} tx: \${txHash}\`);
    await sendTg(\`\u2705 Sold on DEX after graduation\\nTx: <code>\${txHash}</code>\`);
    return txHash;
  } catch (e) {
    logger.error('DEX sell failed: ' + e.message);
    await sendTg(\`\u274c DEX sell failed: \${e.message.slice(0, 100)}\`);
    return null;
  }
}`;

const newSellOnDex = `// Sell on DEX (Uniswap V2 style) after graduation
async function sellOnDex(tokenAddress, tokenAmount) {
  if (!ROUTER || !WETH) {
    logger.debug('No ROUTER/WETH configured - cannot sell on DEX.');
    return null;
  }
  try {
    // 0. Check that a real liquidity pool exists BEFORE attempting anything
    const DEX_FACTORY = config.dexFactory || '';
    if (DEX_FACTORY) {
      const ZERO = '0x0000000000000000000000000000000000000000';
      let pair = ZERO;
      try {
        const dexFac = new ethers.Contract(DEX_FACTORY, ['function getPair(address,address) view returns (address)'], provider);
        pair = await dexFac.getPair(tokenAddress, WETH);
      } catch (e) {
        logger.debug('[DEX SELL] getPair failed: ' + e.message.slice(0, 60));
        return null;
      }
      if (!pair || pair.toLowerCase() === ZERO.toLowerCase()) {
        logger.debug(\`[DEX SELL] No liquidity pool for \${tokenAddress} yet - holding\`);
        return null;
      }
      // Check pool has reserves
      try {
        const pairC = new ethers.Contract(pair, ['function getReserves() view returns (uint112,uint112,uint32)'], provider);
        const reserves = await pairC.getReserves();
        if (reserves[0] === 0n && reserves[1] === 0n) {
          logger.debug(\`[DEX SELL] Pool empty reserves for \${tokenAddress} - holding\`);
          return null;
        }
      } catch (e) {
        logger.debug('[DEX SELL] getReserves failed: ' + e.message.slice(0, 60));
        return null;
      }
    }

    // 1. Approve router if needed
    const erc20ABI = [
      'function allowance(address owner, address spender) external view returns (uint256)',
      'function approve(address spender, uint256 amount) external returns (bool)'
    ];
    const tokenContract = new ethers.Contract(tokenAddress, erc20ABI, wallet);
    const allowance = await tokenContract.allowance(wallet.address, ROUTER).catch(() => 0n);
    if (allowance < tokenAmount) {
      logger.info(\`Approving router for \${tokenAddress}...\`);
      const approveTx = await tokenContract.approve(ROUTER, ethers.MaxUint256, { gasLimit: 100000 });
      await approveTx.wait();
    }

    const router = new ethers.Contract(ROUTER, routerABI, wallet);
    const path = [tokenAddress, WETH];
    const deadline = Math.floor(Date.now() / 1000) + 300;

    let minOut = 0n;
    try {
      const amounts = await router.getAmountsOut(tokenAmount, path);
      if (amounts && amounts.length >= 2) {
        minOut = amounts[1] * BigInt(100 - SLIPPAGE_PCT) / 100n;
      }
    } catch (e) {
      logger.warn('getAmountsOut failed: ' + e.message);
    }

    const tx = await router.swapExactTokensForETHSupportingFeeOnTransferTokens(
      tokenAmount, minOut, path, wallet.address, deadline, { gasLimit: 600000 }
    );
    const receipt = await tx.wait();
    const txHash = receipt.hash || receipt.transactionHash;
    logger.info(\`[DEX SELL] \${tokenAddress} tx: \${txHash}\`);
    await sendTg(\`\u2705 Sold on DEX!\\nTx: <code>\${txHash}</code>\`);
    return txHash;
  } catch (e) {
    logger.error('DEX sell failed: ' + e.message);
    // No TG spam here - caller handles user messaging
    return null;
  }
}`;

// Normalize line endings for comparison
const srcLF = src.replace(/\r\n/g, '\n');
const oldLF = oldSellOnDex.replace(/\r\n/g, '\n');
const newLF = newSellOnDex.replace(/\r\n/g, '\n');

if (srcLF.includes(oldLF)) {
  src = srcLF.replace(oldLF, newLF);
  // Restore CRLF
  src = src.replace(/\r?\n/g, '\r\n');
  fs.writeFileSync('./robinhood_bot.js', src);
  console.log('✓ sellOnDex patched successfully');
} else {
  console.log('✗ sellOnDex not found - searching for partial match...');
  const idx = srcLF.indexOf('async function sellOnDex');
  console.log('sellOnDex starts at char:', idx);
  // Show surrounding text
  console.log(srcLF.slice(idx, idx + 200));
}
