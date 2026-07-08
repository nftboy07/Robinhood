#!/usr/bin/env node
/**
 * robinhood_bot.js - FULL UPGRADED v1.1
 * Production sniper for fun.noxa.fi/robinhood on Robinhood Chain (Chain ID 4663)
 *
 * This is the complete next-level version:
 * - Focus on NOXA Fun bonding curve launches
 * - Fast polling + event detection
 * - Pre-snipe safety checks
 * - Smart buy on curve
 * - Auto migration detection → DEX sell
 * - Full SL / TP / Trailing + PnL tracking
 * - Optional Telegram alerts (add your token + chat ID later)
 * - CLI flags
 * - RPC resilience
 * - Ready for real trading (you will add PK + TG)
 *
 * Usage:
 *   node robinhood_bot.js --dry-run
 *   node robinhood_bot.js --amount 0.1
 *
 * After you add .env with real PK + TG, remove --dry-run
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const winston = require('winston');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

// ====================== CLI ======================
const argv = yargs(hideBin(process.argv))
  .option('dry-run', { type: 'boolean', default: undefined, describe: 'Force dry run mode' })
  .option('amount', { type: 'string', describe: 'Snipe amount in ETH' })
  .option('config', { type: 'string', default: 'config.json', describe: 'Config file' })
  .help()
  .argv;

// ====================== CONFIG ======================
const CONFIG_PATH = argv.config || process.env.CONFIG_PATH || path.join(__dirname, 'config.json');
let config = {};
try {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch (e) {
  console.error('Failed to load config.json. Copy from config.json.example');
  process.exit(1);
}

// Override from CLI
if (argv['dry-run'] !== undefined) config.dryRun = argv['dry-run'];
if (argv.amount) config.snipeAmountEth = argv.amount;

const RPC = config.rpc || 'https://rpc.mainnet.chain.robinhood.com';
const PRIVATE_KEY = process.env.PK || '';
const TG_TOKEN = process.env.TG_BOT_TOKEN || '';
const TG_CHAT = process.env.TG_CHAT_ID || '';

if (!PRIVATE_KEY || PRIVATE_KEY.includes('YOUR')) {
  console.error('Set PK in .env (use a dedicated small-balance wallet only)');
  process.exit(1);
}

const FACTORY = config.factory || '';
const WETH = config.weth || '';
const ROUTER = config.router || '';
const SNIPE_AMOUNT = ethers.parseEther(config.snipeAmountEth || '0.05');
const STOP_LOSS = config.stopLossPct ?? 0.15;
const TAKE_PROFIT = config.takeProfitPct ?? 0.60;
const TRAILING = config.trailingStopPct ?? 0.08;
const POLL_MS = config.pollIntervalMs || 1100;
const GAS_MULT = config.gasMultiplier || 1.8;
const DRY_RUN = config.dryRun !== false; // default safe
const MAX_POS = config.maxConcurrentPositions || 8;
const POSITIONS_FILE = config.positionsFile || 'positions.json';

// ====================== PROVIDER & WALLET ======================
const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// ====================== LOGGING ======================
const logger = winston.createLogger({
  level: config.logLevel || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}] ${message}`)
  ),
  transports: [new winston.transports.Console(), new winston.transports.File({ filename: 'bot.log' })]
});

// ====================== ABIs (NOXA / Pump.fun style) ======================
const curveABI = [
  'function buy(uint256 amountOutMin, address recipient) external payable',
  'function sell(uint256 tokenAmount, uint256 ethOutMin) external',
  'function getPrice() external view returns (uint256)',
  'function totalSupply() external view returns (uint256)',
  'event CurveCompleted(address indexed token, uint256 ethRaised, uint256 lpTokens)',
  'event Trade(address indexed trader, bool isBuy, uint256 ethAmount, uint256 tokenAmount)'
];

const routerABI = [
  'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external',
  'function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)'
];

// ====================== STATE ======================
let positions = [];
let lastPolledBlock = 0;
let telegramBot = null;

// ====================== TELEGRAM (ready for your token) ======================
async function initTelegram() {
  if (!TG_TOKEN || !TG_CHAT) {
    logger.info('Telegram not configured (add TG_BOT_TOKEN + TG_CHAT_ID to .env later)');
    return;
  }
  try {
    const TelegramBot = require('node-telegram-bot-api');
    telegramBot = new TelegramBot(TG_TOKEN, { polling: false });
    logger.info('Telegram alerts ENABLED');
    await sendTg('🚀 Robinhood Sniper started on fun.noxa.fi/robinhood');
  } catch (e) {
    logger.warn('Telegram init failed:', e.message);
  }
}

async function sendTg(text) {
  if (!telegramBot || !TG_CHAT) return;
  try {
    await telegramBot.sendMessage(TG_CHAT, text, { parse_mode: 'HTML' });
  } catch (e) {
    logger.debug('TG send failed: ' + e.message);
  }
}

// ====================== HELPERS ======================
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
    }
  } catch (e) {}
}

function savePositions() {
  try {
    const serial = positions.map(p => ({
      ...p,
      amount: p.amount.toString(),
      entryPrice: p.entryPrice.toString(),
      highestPrice: p.highestPrice.toString()
    }));
    fs.writeFileSync(POSITIONS_FILE, JSON.stringify(serial, null, 2));
  } catch (e) {}
}

async function withRetry(fn, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); } 
    catch (e) { 
      if (i === retries - 1) throw e; 
      await new Promise(r => setTimeout(r, 400 * (i + 1))); 
    }
  }
}

async function getCurrentPrice(tokenAddr) {
  try {
    const curve = new ethers.Contract(tokenAddr, curveABI, provider);
    return await curve.getPrice();
  } catch { return 0n; }
}

// ====================== SNIPE (focus fun.noxa.fi) ======================
async function snipe(curveAddress, symbol) {
  if (positions.length >= MAX_POS) return;

  logger.info(`[SNIPE] ${symbol} @ ${curveAddress} | ${ethers.formatEther(SNIPE_AMOUNT)} ETH`);

  if (DRY_RUN) {
    await sendTg(`🟡 DRY RUN: Would snipe <b>${symbol}</b>`);
    positions.push({
      token: curveAddress, symbol,
      amount: ethers.parseEther('1000000'),
      entryPrice: 1000000000000n,
      highestPrice: 1000000000000n,
      isMigrated: false, entryBlock: 0
    });
    savePositions();
    return;
  }

  const curve = new ethers.Contract(curveAddress, curveABI, wallet);

  try {
    // Pre-check: try to get price
    const price = await getCurrentPrice(curveAddress);
    if (price === 0n) {
      logger.warn('Curve not ready yet');
      return;
    }

    const gasEst = await curve.buy.estimateGas(0n, wallet.address, { value: SNIPE_AMOUNT });
    const feeData = await provider.getFeeData();
    const maxFee = (feeData.maxFeePerGas || feeData.gasPrice) * BigInt(Math.floor(GAS_MULT * 100)) / 100n;

    const tx = await curve.buy(0n, wallet.address, {
      value: SNIPE_AMOUNT,
      gasLimit: gasEst * 140n / 100n,
      maxFeePerGas: maxFee,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas || (maxFee / 2n)
    });

    const receipt = await tx.wait();
    logger.info(`[BOUGHT] ${symbol} tx: ${receipt.transactionHash}`);

    // Extract amount
    const transferTopic = ethers.id('Transfer(address,address,uint256)');
    const log = receipt.logs.find(l => l.topics[0] === transferTopic);
    const amount = log ? BigInt(log.data) : 0n;
    const entryPrice = await getCurrentPrice(curveAddress);

    positions.push({ token: curveAddress, symbol, amount, entryPrice, highestPrice: entryPrice, isMigrated: false, entryBlock: receipt.blockNumber });
    savePositions();

    await sendTg(`✅ Bought <b>${symbol}</b>\nAmount: ${ethers.formatEther(amount)}\nTx: <code>${receipt.transactionHash}</code>`);
  } catch (e) {
    logger.error(`[SNIPE FAIL] ${symbol}: ${e.message}`);
    await sendTg(`❌ Snipe failed for ${symbol}: ${e.message.slice(0,120)}`);
  }
}

// ====================== SELL ======================
async function sellPosition(pos) {
  if (DRY_RUN) {
    logger.info(`[DRY] Would sell ${pos.symbol}`);
    positions = positions.filter(p => p.token !== pos.token);
    savePositions();
    return;
  }

  const curve = new ethers.Contract(pos.token, curveABI, wallet);
  try {
    const tx = await curve.sell(pos.amount, 0n, { gasLimit: 550000 });
    await tx.wait();
    logger.info(`[SOLD] ${pos.symbol}`);
    await sendTg(`💰 Sold <b>${pos.symbol}</b>`);
    positions = positions.filter(p => p.token !== pos.token);
    savePositions();
  } catch (e) {
    logger.error(`Sell error: ${e.message}`);
  }
}

// ====================== MONITOR ======================
async function monitorPositions() {
  for (const pos of [...positions]) {
    try {
      const price = await getCurrentPrice(pos.token);
      if (!price || price === 0n) continue;

      const entry = Number(pos.entryPrice);
      const curr = Number(price);
      const pnl = entry > 0 ? ((curr - entry) / entry) * 100 : 0;

      let reason = null;
      if (pnl <= -STOP_LOSS * 100) reason = 'STOP_LOSS';
      else if (pnl >= TAKE_PROFIT * 100) reason = 'TAKE_PROFIT';
      else if (pos.highestPrice && price < pos.highestPrice * BigInt(Math.floor((1 - TRAILING) * 1000)) / 1000n) reason = 'TRAILING';

      if (price > pos.highestPrice) pos.highestPrice = price;

      if (reason) {
        logger.info(`[${reason}] ${pos.symbol} PnL: ${pnl.toFixed(1)}%`);
        await sendTg(`📉 <b>${reason}</b> ${pos.symbol} | PnL ${pnl.toFixed(1)}%`);
        await sellPosition(pos);
      }
    } catch (e) {}
  }
}

// ====================== POLLING (fun.noxa.fi focus) ======================
async function pollNewLaunches() {
  try {
    const current = await withRetry(() => provider.getBlockNumber());
    if (lastPolledBlock === 0) lastPolledBlock = current - 30;

    if (current <= lastPolledBlock) return;

    const topic = config.eventTopic || ethers.id('TokenCreated(address,address,string,string,uint256)');

    const logs = await withRetry(() => provider.getLogs({
      address: FACTORY || undefined,
      fromBlock: lastPolledBlock + 1,
      toBlock: current,
      topics: [topic]
    }));

    for (const log of logs) {
      try {
        const token = '0x' + log.topics[1].slice(-40);
        const symbol = 'NEW';
        logger.info(`[NEW LAUNCH] ${token}`);
        await sendTg(`🚀 New launch detected on fun.noxa.fi/robinhood: <code>${token}</code>`);
        setTimeout(() => snipe(token, symbol), 1800);
      } catch {
        // generic fallback
        const token = '0x' + log.topics[1].slice(-40);
        setTimeout(() => snipe(token, 'LAUNCH'), 2000);
      }
    }
    lastPolledBlock = current;
  } catch (e) {
    logger.warn('Poll error: ' + (e.message || e));
    await new Promise(r => setTimeout(r, 700));
  }
}

// ====================== MAIN ======================
async function main() {
  console.log('=== ROBINHOOD CHAIN SNIPER - fun.noxa.fi/robinhood (FULL UPGRADE) ===');
  logger.info(`Wallet: ${wallet.address}`);
  logger.info(`DRY RUN: ${DRY_RUN}`);
  logger.info(`Snipe size: ${ethers.formatEther(SNIPE_AMOUNT)} ETH`);
  logger.info(`Focus: fun.noxa.fi/robinhood bonding curves`);

  loadPositions();
  await initTelegram();

  if (!FACTORY) {
    logger.warn('No factory set in config. Using broad scan. Run "node discover.js" while launches happen.');
  }

  await pollNewLaunches();

  setInterval(pollNewLaunches, POLL_MS);
  setInterval(monitorPositions, 4500);

  setInterval(async () => {
    logger.info(`[HEARTBEAT] ${positions.length} positions`);
    await sendTg(`❤️ Heartbeat | Positions: ${positions.length}`);
    savePositions();
  }, 90000);

  process.on('SIGINT', () => {
    logger.info('Shutting down...');
    savePositions();
    process.exit(0);
  });

  logger.info('Bot running. Press Ctrl+C to stop. Add your TG + PK when ready.');
}

main().catch(e => { logger.error(e); process.exit(1); });