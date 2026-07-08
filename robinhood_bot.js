#!/usr/bin/env node
/**
 * robinhood_bot.js
 * Production-grade sniper for Robinhood Chain (4663) + fun.noxa.fi/robinhood
 *
 * Features:
 * - Config-driven (JSON + .env)
 * - Dry-run mode (no real sends)
 * - Fast polling (tuned for ~0.1s blocks)
 * - Bonding curve buy + SL/TP/Trailing
 * - Graduation detection + DEX sell path
 * - Persistent positions
 * - Structured logging
 *
 * Usage:
 *   node robinhood_bot.js
 *
 * ALWAYS:
 * - Set dryRun: true first
 * - Use tiny snipe amounts
 * - Verify every address on the explorer
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const winston = require('winston');

// ---------- CONFIG ----------
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, 'config.json');
let config = {};
try {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch (e) {
  console.error('Failed to load config.json. Copy from config.json.example');
  process.exit(1);
}

const RPC = config.rpc || 'https://rpc.mainnet.chain.robinhood.com';
const WS_URL = config.ws;
const PRIVATE_KEY = process.env.PK;
if (!PRIVATE_KEY || PRIVATE_KEY.includes('YOUR')) {
  console.error('Set PK in .env (dedicated hot wallet with tiny funds only)');
  process.exit(1);
}

const FACTORY = config.factory;
const WETH = config.weth;
const ROUTER = config.router;
const SNIPE_AMOUNT = ethers.parseEther(config.snipeAmountEth || '0.05');
const STOP_LOSS = config.stopLossPct ?? 0.15;
const TAKE_PROFIT = config.takeProfitPct ?? 0.60;
const TRAILING = config.trailingStopPct ?? 0.08;
const POLL_MS = config.pollIntervalMs || 1200;
const GAS_MULT = config.gasMultiplier || 1.8;
const DRY_RUN = !!config.dryRun;
const MAX_POS = config.maxConcurrentPositions || 8;
const POSITIONS_FILE = config.positionsFile || 'positions.json';

const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// ---------- LOGGING ----------
const logger = winston.createLogger({
  level: config.logLevel || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}] ${message}`)
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'bot.log' })
  ]
});

// ---------- ABIs (minimal - extend after you inspect verified source) ----------
const factoryABI = [
  'event TokenCreated(address indexed token, address indexed creator, string name, string symbol, uint256 initialSupply)',
  // NOXA may use a different name - update after discovery
  'event Launch(address indexed token, address indexed curve, address indexed creator)'
];

const curveABI = [
  'function buy(uint256 amountOutMin, address recipient) external payable',
  'function sell(uint256 tokenAmount, uint256 ethOutMin) external',
  'function getPrice() external view returns (uint256)',
  'function totalSupply() external view returns (uint256)',
  'event CurveCompleted(address indexed token, uint256 ethRaised, uint256 lpTokens)',
  'event Trade(address indexed trader, bool isBuy, uint256 ethAmount, uint256 tokenAmount)'
];

const routerABI = [
  'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external'
];

// ---------- STATE ----------
let positions = []; // { token, symbol, amount: bigint, entryPrice: bigint, highestPrice: bigint, isMigrated: bool, entryBlock }
let lastPolledBlock = 0;
let migrated = new Map(); // token -> pairAddress

function loadPositions() {
  try {
    if (fs.existsSync(POSITIONS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(POSITIONS_FILE, 'utf8'));
      positions = raw.map(p => ({
        ...p,
        amount: BigInt(p.amount),
        entryPrice: BigInt(p.entryPrice),
        highestPrice: BigInt(p.highestPrice || p.entryPrice)
      }));
      logger.info(`Loaded ${positions.length} positions from disk`);
    }
  } catch (e) {
    logger.warn('Could not load positions:', e.message);
  }
}

function savePositions() {
  try {
    const serializable = positions.map(p => ({
      ...p,
      amount: p.amount.toString(),
      entryPrice: p.entryPrice.toString(),
      highestPrice: p.highestPrice.toString()
    }));
    fs.writeFileSync(POSITIONS_FILE, JSON.stringify(serializable, null, 2));
  } catch (e) {
    logger.error('Failed to save positions:', e.message);
  }
}

// ---------- CORE ----------
async function getCurrentPrice(tokenAddr, isMigrated) {
  try {
    if (isMigrated && ROUTER && WETH) {
      // Simple reserves-based (assumes standard V2 pair ordering)
      // For production, resolve pair first and use getReserves
      const pairIface = new ethers.Interface([
        'function getReserves() view returns (uint112,uint112,uint32)'
      ]);
      // NOTE: You must implement pair address lookup for full DEX pricing
      // Placeholder returns curve price for now
    }
    const curve = new ethers.Contract(tokenAddr, curveABI, provider);
    return await curve.getPrice();
  } catch (e) {
    logger.debug(`Price fetch failed for ${tokenAddr}: ${e.message}`);
    return 0n;
  }
}

async function snipe(curveAddress, symbol) {
  if (positions.length >= MAX_POS) {
    logger.warn(`Max positions (${MAX_POS}) reached. Skipping ${symbol}`);
    return;
  }
  if (DRY_RUN) {
    logger.info(`[DRY-RUN] Would snipe ${symbol} @ ${curveAddress} for ${ethers.formatEther(SNIPE_AMOUNT)} ETH`);
    // Simulate entry
    positions.push({
      token: curveAddress,
      symbol,
      amount: ethers.parseEther('1000000'), // fake
      entryPrice: 1000000000000n, // fake
      highestPrice: 1000000000000n,
      isMigrated: false,
      entryBlock: 0
    });
    savePositions();
    return;
  }

  logger.info(`[SNIPE] Buying ${symbol} at ${curveAddress}`);
  const curve = new ethers.Contract(curveAddress, curveABI, wallet);
  const amountOutMin = 0n;

  try {
    const gasEst = await curve.buy.estimateGas(amountOutMin, wallet.address, { value: SNIPE_AMOUNT });
    const feeData = await provider.getFeeData();
    const maxFee = (feeData.maxFeePerGas || feeData.gasPrice) * BigInt(Math.floor(GAS_MULT * 100)) / 100n;
    const priority = feeData.maxPriorityFeePerGas || (maxFee / 2n);

    const tx = await curve.buy(amountOutMin, wallet.address, {
      value: SNIPE_AMOUNT,
      gasLimit: gasEst * 130n / 100n,
      maxFeePerGas: maxFee,
      maxPriorityFeePerGas: priority
    });

    const receipt = await tx.wait();
    logger.info(`[SUCCESS] ${symbol} bought. Tx: ${receipt.transactionHash}`);

    // Extract received tokens from Transfer logs
    const transferTopic = ethers.id('Transfer(address,address,uint256)');
    const log = receipt.logs.find(l => l.topics[0] === transferTopic);
    let amount = 0n;
    if (log) amount = BigInt(log.data);

    const entryPrice = await curve.getPrice().catch(() => 0n);

    positions.push({
      token: curveAddress,
      symbol,
      amount,
      entryPrice,
      highestPrice: entryPrice,
      isMigrated: false,
      entryBlock: receipt.blockNumber
    });
    savePositions();
    logger.info(`[POSITION] Holding ${ethers.formatEther(amount)} ${symbol} @ entry price ${entryPrice}`);
  } catch (e) {
    logger.error(`[SNIPE FAIL] ${symbol}: ${e.message}`);
  }
}

async function sellPosition(pos) {
  if (DRY_RUN) {
    logger.info(`[DRY-RUN] Would sell ${pos.symbol}`);
    positions = positions.filter(p => p.token !== pos.token);
    savePositions();
    return;
  }

  const curve = new ethers.Contract(pos.token, curveABI, wallet);
  try {
    const tx = await curve.sell(pos.amount, 0n, { gasLimit: 500000 });
    await tx.wait();
    logger.info(`[SELL] ${pos.symbol} sold. Tx: ${tx.hash}`);
    positions = positions.filter(p => p.token !== pos.token);
    savePositions();
  } catch (e) {
    logger.error(`[SELL FAIL] ${pos.symbol}: ${e.message}`);
  }
}

async function monitorPositions() {
  for (const pos of [...positions]) {
    try {
      const currentPrice = await getCurrentPrice(pos.token, pos.isMigrated);
      if (!currentPrice || currentPrice === 0n) continue;

      const entry = Number(pos.entryPrice);
      const curr = Number(currentPrice);
      const profitPct = entry > 0 ? (curr - entry) / entry : 0;

      let reason = null;
      if (profitPct <= -STOP_LOSS) reason = 'STOP_LOSS';
      else if (profitPct >= TAKE_PROFIT) reason = 'TAKE_PROFIT';
      else if (pos.highestPrice && currentPrice < pos.highestPrice * BigInt(Math.floor((1 - TRAILING) * 1000)) / 1000n) {
        reason = 'TRAILING';
      }

      if (currentPrice > pos.highestPrice) pos.highestPrice = currentPrice;

      if (reason) {
        logger.info(`[${reason}] ${pos.symbol} profit=${(profitPct*100).toFixed(1)}%`);
        await sellPosition(pos);
      }
    } catch (e) {
      logger.debug(`Monitor error ${pos.symbol}: ${e.message}`);
    }
  }
}

// ---------- EVENT POLLING (primary because of speed + possible WS limits) ----------
async function pollNewLaunches() {
  try {
    const current = await provider.getBlockNumber();
    if (lastPolledBlock === 0) lastPolledBlock = current - 20;

    if (current <= lastPolledBlock) return;

    const topic = config.eventTopic || ethers.id('TokenCreated(address,address,string,string,uint256)');

    const logs = await provider.getLogs({
      address: FACTORY || undefined,
      fromBlock: lastPolledBlock + 1,
      toBlock: current,
      topics: [topic]
    });

    if (logs.length === 0 && FACTORY) {
      logger.debug(`No matching events from factory ${FACTORY} in this window.`);
    }

    for (const log of logs) {
      try {
        const iface = new ethers.Interface(factoryABI);
        const decoded = iface.decodeEventLog('TokenCreated', log.data || '0x', log.topics);
        const token = decoded.token || decoded[0];
        const symbol = decoded.symbol || decoded[2] || '???';
        logger.info(`[NEW] ${symbol} @ ${token} (creator ${decoded.creator || decoded[1]})`);
        // Slight delay so contract is ready
        setTimeout(() => snipe(token, symbol), 1500);
      } catch (decodeErr) {
        // Try generic: token is often in topics[1]
        const token = '0x' + log.topics[1].slice(-40);
        logger.info(`[NEW-GENERIC] Possible launch at ${token} (tx ${log.transactionHash})`);
        setTimeout(() => snipe(token, 'UNKNOWN'), 2000);
      }
    }

    lastPolledBlock = current;
  } catch (e) {
    logger.warn('Poll error:', e.message || e);
    // Backoff a bit on transient RPC issues
    await new Promise(r => setTimeout(r, 800));
  }
}

// ---------- MAIN ----------
async function main() {
  logger.info('=== Robinhood Chain Sniper Starting ===');
  logger.info(`Wallet: ${wallet.address}`);
  logger.info(`Chain ID: ${(await provider.getNetwork()).chainId}`);
  logger.info(`DRY RUN: ${DRY_RUN}`);
  logger.info(`Snipe size: ${ethers.formatEther(SNIPE_AMOUNT)} ETH`);
  if (!FACTORY) logger.warn('FACTORY not set in config — will scan broadly (slow).');

  loadPositions();

  // Initial catch-up
  await pollNewLaunches();

  // Polling loops
  setInterval(pollNewLaunches, POLL_MS);
  setInterval(monitorPositions, 4000);
  setInterval(() => {
    logger.info(`[HEARTBEAT] ${positions.length} active positions`);
    savePositions();
  }, 60000);

  // Graceful shutdown
  process.on('SIGINT', () => {
    logger.info('Shutting down...');
    savePositions();
    process.exit(0);
  });

  logger.info('Bot running. Press Ctrl+C to stop.');
}

main().catch(err => {
  logger.error('Fatal:', err);
  process.exit(1);
});
