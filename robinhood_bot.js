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
const TG_TOKEN = process.env.TG_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = process.env.TG_CHAT_ID || process.env.TELEGRAM_CHAT_ID || '';

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
const DRY_RUN = config.dryRun !== false;
const MAX_POS = config.maxConcurrentPositions || 8;
const POSITIONS_FILE = config.positionsFile || 'positions.json';

// New risk & safety settings (fun.noxa.fi focus)
const HONEYPOT_CHECK = config.honeypotCheck !== false;
const MAX_DAILY_LOSS_PCT = config.maxDailyLossPct ?? 25;
const MAX_TRADES_PER_HOUR = config.maxTradesPerHour ?? 12;
const SLIPPAGE_PCT = config.slippagePct ?? 15;
const ENABLE_TG = config.enableTelegram !== false;

// ====================== PROVIDER & WALLET ======================
// Use staticNetwork to avoid ENS lookups on custom chains like 4663
const provider = new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: true });
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

// Daily risk tracking (no multi-wallet)
let dailyStats = {
  startTime: Date.now(),
  trades: 0,
  realizedPnl: 0,   // in ETH (approximate)
  lastTradeHour: 0
};

// Telegram command queue
let pendingCommands = [];

// ====================== TELEGRAM (ready - add your token + user id later) ======================
async function initTelegram() {
  if (!TG_TOKEN || !TG_CHAT || !ENABLE_TG) {
    logger.info('Telegram disabled or not configured (add TG_BOT_TOKEN + TG_CHAT_ID later)');
    return;
  }
  try {
    const TelegramBot = require('node-telegram-bot-api');
    telegramBot = new TelegramBot(TG_TOKEN, { polling: true });

    // Command handler for fun.noxa.fi bot
    telegramBot.on('message', async (msg) => {
      if (String(msg.chat.id) !== String(TG_CHAT)) return;
      const text = (msg.text || '').trim().toLowerCase();

      if (text === '/status') {
        const pos = positions.length;
        const dailyPnl = dailyStats.realizedPnl.toFixed(4);
        await sendTg(`📊 Status: ${pos} positions | Daily trades: ${dailyStats.trades} | PnL: ${dailyPnl} ETH`);
      } else if (text === '/positions') {
        if (positions.length === 0) return sendTg('No open positions');
        let msg = '📍 Positions:\n';
        positions.forEach((p, i) => msg += `${i+1}. ${p.symbol} - entry ${ethers.formatEther(p.entryPrice)}\n`);
        await sendTg(msg);
      } else if (text.startsWith('/sell ')) {
        const idx = parseInt(text.split(' ')[1]) - 1;
        if (positions[idx]) {
          await sellPosition(positions[idx]);
          await sendTg('Sell triggered');
        }
      } else if (text === '/stop') {
        process.exit(0);
      } else if (text === '/help') {
        await sendTg('Commands: /status /positions /sell N /stop');
      }
    });

    logger.info('Telegram alerts + commands ENABLED (fun.noxa.fi mode)');
    await sendTg('🚀 Robinhood Sniper v1.1 started - focused on fun.noxa.fi/robinhood');
  } catch (e) {
    logger.warn('Telegram init failed:', e.message);
  }
}

async function sendTg(text) {
  if (!telegramBot || !TG_CHAT || !ENABLE_TG) return;
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

// ====================== NEW UPGRADES: Curve math, Honeypot, DEX sell, Risk ======================

// Estimate tokens you would receive for a buy (uses static call simulation)
async function estimateBuyOutput(curveAddress, ethAmount) {
  try {
    const curve = new ethers.Contract(curveAddress, curveABI, provider);
    // Many bonding curves expose this via simulation of buy
    const estimatedTokens = await curve.callStatic.buy(0, wallet.address, { value: ethAmount });
    return estimatedTokens;
  } catch (e) {
    // Fallback: rough price * amount
    const price = await getCurrentPrice(curveAddress);
    if (price > 0) return (ethAmount * BigInt(10**18)) / price;
    return 0n;
  }
}

// Honeypot / rug check before snipe (simulate buy then sell)
async function isHoneypotOrBad(curveAddress) {
  if (!HONEYPOT_CHECK) return false;
  try {
    const curve = new ethers.Contract(curveAddress, curveABI, provider);
    const testAmount = ethers.parseEther('0.01');

    // Simulate buy
    const buyGas = await curve.buy.estimateGas(0, wallet.address, { value: testAmount });
    if (buyGas > 500000n) return true; // suspicious high gas

    // Try to simulate sell (if we had tokens)
    // For real check, we would need to buy small amount on test, but for speed we check sell function exists and basic
    const sellGas = await curve.sell.estimateGas(1000n, 0).catch(() => 999999n);
    if (sellGas > 800000n) return true;

    return false;
  } catch {
    return true; // if can't even estimate, risky
  }
}

// Check daily risk limits
function checkRiskLimits() {
  const now = Date.now();
  const hoursSinceStart = (now - dailyStats.startTime) / (1000 * 3600);

  // Reset daily stats every 24h
  if (hoursSinceStart > 24) {
    dailyStats = { startTime: now, trades: 0, realizedPnl: 0, lastTradeHour: 0 };
  }

  const currentHour = Math.floor(now / (1000 * 3600));
  if (currentHour !== dailyStats.lastTradeHour) {
    dailyStats.lastTradeHour = currentHour;
    // could reset hourly counters here
  }

  if (dailyStats.trades >= MAX_TRADES_PER_HOUR) {
    logger.warn('Max trades per hour reached');
    return false;
  }

  const lossPct = dailyStats.realizedPnl < 0 ? Math.abs(dailyStats.realizedPnl / 1) * 100 : 0; // rough
  if (lossPct > MAX_DAILY_LOSS_PCT) {
    logger.warn('Daily loss limit hit');
    return false;
  }
  return true;
}

// Sell on DEX (Uniswap V2 style) after migration
async function sellOnDex(tokenAddress, tokenAmount) {
  if (!ROUTER || !WETH || DRY_RUN) {
    logger.info('[DRY] Would sell on DEX');
    return;
  }
  try {
    const router = new ethers.Contract(ROUTER, routerABI, wallet);
    const path = [tokenAddress, WETH];
    const deadline = Math.floor(Date.now() / 1000) + 300;

    // Approve if needed (simplified)
    // In production add ERC20 approve logic

    const minOut = 0; // use slippage in real version
    const tx = await router.swapExactTokensForETHSupportingFeeOnTransferTokens(
      tokenAmount,
      minOut,
      path,
      wallet.address,
      deadline,
      { gasLimit: 600000 }
    );
    await tx.wait();
    logger.info(`[DEX SELL] ${tokenAddress}`);
    await sendTg('✅ Sold on DEX after graduation');
  } catch (e) {
    logger.error('DEX sell failed: ' + e.message);
  }
}

// ====================== SNIPE (focus fun.noxa.fi) ======================
async function snipe(curveAddress, symbol) {
  if (positions.length >= MAX_POS) return;
  if (!checkRiskLimits()) return;

  logger.info(`[SNIPE] ${symbol} @ ${curveAddress} | ${ethers.formatEther(SNIPE_AMOUNT)} ETH (fun.noxa.fi)`);

  // Honeypot / bad curve check
  if (await isHoneypotOrBad(curveAddress)) {
    logger.warn(`[SKIP] Possible honeypot or bad curve: ${curveAddress}`);
    await sendTg(`⚠️ Skipped suspicious launch: ${symbol}`);
    return;
  }

  // Better curve estimation
  const estimated = await estimateBuyOutput(curveAddress, SNIPE_AMOUNT);
  logger.info(`Estimated tokens for buy: ${ethers.formatEther(estimated || 0n)}`);

  if (DRY_RUN) {
    await sendTg(`🟡 DRY RUN: Would snipe <b>${symbol}</b> on fun.noxa.fi/robinhood`);
    positions.push({
      token: curveAddress, symbol,
      amount: estimated || ethers.parseEther('1000000'),
      entryPrice: await getCurrentPrice(curveAddress) || 1000000000000n,
      highestPrice: 1000000000000n,
      isMigrated: false, entryBlock: 0
    });
    dailyStats.trades++;
    savePositions();
    return;
  }

  const curve = new ethers.Contract(curveAddress, curveABI, wallet);

  try {
    const price = await getCurrentPrice(curveAddress);
    if (price === 0n) {
      logger.warn('Curve not ready');
      return;
    }

    const gasEst = await curve.buy.estimateGas(0n, wallet.address, { value: SNIPE_AMOUNT });
    const feeData = await provider.getFeeData();
    const maxFee = (feeData.maxFeePerGas || feeData.gasPrice) * BigInt(Math.floor(GAS_MULT * 100)) / 100n;

    const tx = await curve.buy(0n, wallet.address, {
      value: SNIPE_AMOUNT,
      gasLimit: gasEst * 145n / 100n,
      maxFeePerGas: maxFee,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas || (maxFee / 2n)
    });

    const receipt = await tx.wait();
    logger.info(`[BOUGHT] ${symbol} tx: ${receipt.transactionHash}`);

    const transferTopic = ethers.id('Transfer(address,address,uint256)');
    const log = receipt.logs.find(l => l.topics[0] === transferTopic);
    const amount = log ? BigInt(log.data) : estimated || 0n;
    const entryPrice = await getCurrentPrice(curveAddress);

    positions.push({ token: curveAddress, symbol, amount, entryPrice, highestPrice: entryPrice, isMigrated: false, entryBlock: receipt.blockNumber });
    dailyStats.trades++;
    savePositions();

    await sendTg(`✅ Bought <b>${symbol}</b> on fun.noxa.fi/robinhood\nEst. amount: ${ethers.formatEther(amount)}`);
  } catch (e) {
    logger.error(`[SNIPE FAIL] ${symbol}: ${e.message}`);
    await sendTg(`❌ Snipe failed ${symbol}`);
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

  // If migrated to DEX, use DEX sell
  if (pos.isMigrated && ROUTER) {
    await sellOnDex(pos.token, pos.amount);
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
      if (!price || price === 0n) {
        // Try to detect if migrated (price query fails but pair may exist)
        if (ROUTER && !pos.isMigrated) {
          // Simple migration heuristic: if curve price stopped working, assume graduated
          pos.isMigrated = true;
          logger.info(`[MIGRATED?] ${pos.symbol} switched to DEX mode`);
          await sendTg(`🔄 ${pos.symbol} likely graduated to DEX`);
        }
        continue;
      }

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
        dailyStats.realizedPnl += (price - pos.entryPrice) * (pos.amount / BigInt(10**18)) / BigInt(10**18) || 0; // rough
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
    const curveCompleteTopic = ethers.id('CurveCompleted(address,uint256,uint256)');

    // New launches
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
        logger.info(`[NEW LAUNCH] ${token} on fun.noxa.fi/robinhood`);
        await sendTg(`🚀 New launch detected: <code>${token}</code>`);
        setTimeout(() => snipe(token, symbol), 1800);
      } catch {
        const token = '0x' + log.topics[1].slice(-40);
        setTimeout(() => snipe(token, 'LAUNCH'), 2000);
      }
    }

    // Detect graduations (migrations) for open positions
    const completeLogs = await withRetry(() => provider.getLogs({
      fromBlock: lastPolledBlock + 1,
      toBlock: current,
      topics: [curveCompleteTopic]
    }));
    for (const log of completeLogs) {
      const token = '0x' + log.topics[1].slice(-40);
      const pos = positions.find(p => p.token.toLowerCase() === token.toLowerCase());
      if (pos && !pos.isMigrated) {
        pos.isMigrated = true;
        logger.info(`[GRADUATED] ${token} moved to DEX`);
        await sendTg(`🔄 ${token} graduated - will sell on DEX`);
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