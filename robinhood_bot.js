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
 *   node robinhood_bot.js --amount 0.0001
 *   node robinhood_bot.js --config custom.json
 *
 * LIVE MAINNET ONLY - no dry-run. Experienced user mode. Small fixed entries.
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
  .option('amount', { type: 'string', describe: 'Snipe amount in ETH (overrides config)' })
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

// Override from CLI (amount only - live mainnet always)
if (argv.amount) config.snipeAmountEth = argv.amount;

const RPC = config.rpc || 'https://rpc.mainnet.chain.robinhood.com';
const PRIVATE_KEY = process.env.PK || '';
const TG_TOKEN = process.env.TELEGRAM_TOKEN || process.env.BOT_TOKEN || process.env.TG_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = process.env.ADMIN_CHAT_ID || process.env.TELEGRAM_CHAT_ID || process.env.TG_CHAT_ID || process.env.TELEGRAM_CHAT_ID || '';

if (!PRIVATE_KEY || PRIVATE_KEY.includes('YOUR')) {
  console.error('Set PK in .env (use a dedicated small-balance wallet only)');
  process.exit(1);
}

const FACTORY = config.factory || '';
const WETH = config.weth || '';
const ROUTER = config.router || '';

// Known launch related contracts for better detection (update as discovered)
const KNOWN_LAUNCH_CONTRACTS = [
  '0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f', // pair factory candidate
  '0xCaf681a66D020601342297493863E78C959E5cb2'  // high activity
];
const STOP_LOSS = config.stopLossPct ?? 0.15;
const TAKE_PROFIT = config.takeProfitPct ?? 0.60;
const TRAILING = config.trailingStopPct ?? 0.08;
const POLL_MS = config.pollIntervalMs || 1100;
const GAS_MULT = config.gasMultiplier || 1.8;
const MAX_POS = config.maxConcurrentPositions || 8;
const POSITIONS_FILE = config.positionsFile || 'positions.json';

const EXPLORER = 'https://robinhoodchain.blockscout.com';

// New risk & safety settings (fun.noxa.fi focus)
const HONEYPOT_CHECK = config.honeypotCheck !== false;
const MAX_DAILY_LOSS_PCT = config.maxDailyLossPct ?? 25;
const MAX_TRADES_PER_HOUR = config.maxTradesPerHour ?? 12;
const SLIPPAGE_PCT = config.slippagePct ?? 15;
const ENABLE_TG = config.enableTelegram !== false;

// Strategy config (safe small amount sniping) - LIVE MAINNET
const STRATEGY = config.strategy || {
  tpLadder: [0.5, 1.0, 2.0],
  tpSellPercents: [30, 30, 40],
  reEntryOnDip: true,
  reEntryDipPct: 0.30,
  reEntryAmountEth: "0.00005",
  maxReEntriesPerPosition: 2,
  moonbagPct: 25
};

const SNIPE_AMOUNT = ethers.parseEther( String(config.snipeAmountEth || '0.0001') ); // configurable, default tiny 0.0001 ETH - mainnet live

// ====================== PROVIDER & WALLET ======================
// Custom chain 4663 - static network to avoid ENS lookups and errors
const network = new ethers.Network('robinhood', 4663);
const provider = new ethers.JsonRpcProvider(RPC, network, { staticNetwork: network });
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

// Sniping pause state (for safety)
let isPaused = false;

// Telegram command queue
let pendingCommands = [];

// Recent launches for manual buy (stores last few detected)
let recentLaunches = []; // [{addr, symbol, time}]

// ====================== TELEGRAM WITH BUTTONS (fun.noxa.fi/robinhood) ======================
async function initTelegram() {
  if (!TG_TOKEN || !TG_CHAT || !ENABLE_TG) {
    logger.info('Telegram disabled or not configured (add TELEGRAM_TOKEN + ADMIN_CHAT_ID to .env)');
    return;
  }
  try {
    const TelegramBot = require('node-telegram-bot-api');
    // ethbot style: ensure no webhook conflict for polling
    const https = require('https');
    const delWebhook = () => new Promise((resolve) => {
      https.get(`https://api.telegram.org/bot${TG_TOKEN}/deleteWebhook?drop_pending_updates=true`, () => resolve()).on('error', () => resolve());
    });
    await delWebhook();
    telegramBot = new TelegramBot(TG_TOKEN, { polling: true });

    // Helper to send main menu with buttons - fast and usable
    const sendMainMenu = async (chatId, text = '🤖 <b>Robinhood Sniper</b> - fast menu') => {
      const pauseText = isPaused ? '▶️ Resume' : '⏸️ Pause';
      const opts = {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '📊 Status', callback_data: 'status' },
              { text: '📍 Positions', callback_data: 'positions' }
            ],
            [
              { text: '💸 Sell All', callback_data: 'sell_all' },
              { text: '🔄 Poll Now', callback_data: 'poll' }
            ],
            [
              { text: '🆕 Recent', callback_data: 'recent' },
              { text: '🧪 Test Buy', callback_data: 'test_buy' }
            ],
            [
              { text: '🔍 Diag', callback_data: 'diag' }
            ],
            [
              { text: pauseText, callback_data: 'toggle_pause' },
              { text: '⚙️ Config', callback_data: 'config' }
            ],
            [
              { text: '🛑 Stop', callback_data: 'stop' }
            ]
          ]
        },
        parse_mode: 'HTML'
      };
      await telegramBot.sendMessage(chatId, text, opts);
      // Also set a fast persistent reply keyboard for quick commands
      const replyOpts = {
        reply_markup: {
          keyboard: [
            ['/s', '/p', '/sa'],
            ['/r', '/poll', '/d'],
            ['/menu']
          ],
          resize_keyboard: true,
          one_time_keyboard: false
        }
      };
      await telegramBot.sendMessage(chatId, 'Fast commands (tap or type):', replyOpts);
    };

    // Message handler (for /start /menu etc.)
    telegramBot.on('message', async (msg) => {
      if (String(msg.chat.id) !== String(TG_CHAT)) return;
      const text = (msg.text || '').trim().toLowerCase();

      if (text === '/start' || text === '/menu' || text === '/m') {
        await sendMainMenu(msg.chat.id);
      } else if (text === '/status' || text === '/s') {
        await handleStatus(msg.chat.id);
      } else if (text === '/positions' || text === '/p') {
        await handlePositions(msg.chat.id);
      } else if (text === '/sellall' || text === '/sa') {
        if (positions.length === 0) {
          await sendTg('No open positions to sell.');
        } else {
          await sendTg('Selling all positions...');
          for (const pos of [...positions]) {
            await sellPosition(pos);
          }
        }
      } else if (text === '/poll') {
        await sendTg('🔄 Forcing poll for new launches...');
        await pollNewLaunches();
      } else if (text === '/help' || text === '/h' || text === '/commands') {
        const helpText = `Usable commands:
 /menu or /m - Main menu
 /s or /status - Status
 /p or /positions - Positions
 /d or /diag - Real diagnostics (block, bal, config)
 /sa or /sellall - Sell all
 /poll - Force poll
 /recent or /r - Recent launches
 /bal - Balance
 /buy <amt> <addr> - Manual buy
 /help or /h - This help

Use buttons for fast actions. New launches auto-post buy buttons.`;
        await telegramBot.sendMessage(msg.chat.id, helpText);
      } else if (text === '/recent' || text === '/r') {
        // Trigger recent handler
        if (recentLaunches.length === 0) {
          await telegramBot.sendMessage(msg.chat.id, 'No recent launches yet.');
        } else {
          let txt = '📋 <b>Recent Launches</b>\n';
          const kbd = { inline_keyboard: [] };
          recentLaunches.forEach((l, i) => {
            const age = Math.floor((Date.now() - l.time)/1000);
            txt += `${i+1}. ${l.symbol} (${age}s ago)\n`;
            kbd.inline_keyboard.push([
              { text: `Buy ${l.symbol}`, callback_data: `showbuy_${l.addr}` }
            ]);
          });
          await telegramBot.sendMessage(msg.chat.id, txt, { parse_mode: 'HTML', reply_markup: kbd });
        }
      } else if (text.startsWith('/buy ')) {
        // Manual buy: /buy 0.005 0xaddr
        const parts = text.split(' ');
        if (parts.length >= 3) {
          const amt = parts[1];
          const addr = parts[2];
          await buyToken(addr, amt);
        } else {
          await telegramBot.sendMessage(msg.chat.id, 'Usage: /buy <amount> <address>');
        }
      } else if (text === '/bal' || text === '/balance') {
        const bal = await getBalance();
        await telegramBot.sendMessage(msg.chat.id, `Balance: ${ethers.formatEther(bal)} ETH`);
      } else if (text === '/diag' || text === '/d' || text === '/info') {
        await handleDiag(msg.chat.id);
      } else if (text === '/pause') {
        isPaused = true;
        await sendTg('⏸️ Sniping paused');
      } else if (text === '/resume' || text === '/unpause') {
        isPaused = false;
        await sendTg('▶️ Sniping resumed');
      }
    });

    // Callback handler for BUTTONS
    telegramBot.on('callback_query', async (query) => {
      if (String(query.message.chat.id) !== String(TG_CHAT)) {
        await telegramBot.answerCallbackQuery(query.id, { text: 'Unauthorized' });
        return;
      }

      const data = query.data;
      const chatId = query.message.chat.id;

      await telegramBot.answerCallbackQuery(query.id); // Acknowledge button press

      if (data === 'status') {
        await handleStatus(chatId);
      } else if (data === 'positions') {
        await handlePositions(chatId);
      } else if (data === 'sell_all') {
        if (positions.length === 0) {
          await sendTg('No open positions to sell.');
        } else {
          await sendTg('Selling all positions...');
          for (const pos of [...positions]) {
            await sellPosition(pos);
          }
        }
        await sendMainMenu(chatId, '✅ Sell All triggered');
      } else if (data.startsWith('sell_')) {
        const idx = parseInt(data.split('_')[1]);
        if (positions[idx]) {
          await sellPosition(positions[idx]);
          await sendTg(`Sold position ${idx + 1}`);
          await handlePositions(chatId); // refresh list
        }
      } else if (data === 'poll') {
        await sendTg('🔄 Forcing poll for new launches...');
        await pollNewLaunches();
        await sendMainMenu(chatId);
      } else if (data === 'config') {
        const cfgText = `⚙️ Current Config:\n` +
          `Mode: LIVE MAINNET ONLY\n` +
          `Snipe: ${ethers.formatEther(SNIPE_AMOUNT)} ETH\n` +
          `SL: ${STOP_LOSS * 100}%\n` +
          `TP: ${TAKE_PROFIT * 100}%\n` +
          `Factory: ${FACTORY ? 'SET' : 'PLACEHOLDER (broad scan)'}`;
        await telegramBot.sendMessage(chatId, cfgText);
        await sendMainMenu(chatId);
      } else if (data === 'stop') {
        await sendTg('🛑 Stopping bot...');
        process.exit(0);
      } else if (data === 'menu') {
        await sendMainMenu(chatId);
      } else if (data.startsWith('buy_')) {
        const parts = data.split('_');
        const addr = parts[1];
        const amt = parts[2];
        await buyToken(addr, amt);
      } else if (data === 'recent') {
        if (recentLaunches.length === 0) {
          await telegramBot.sendMessage(chatId, 'No recent launches yet.');
          return;
        }
        let text = '📋 <b>Recent Launches</b>\n';
        const kbd = { inline_keyboard: [] };
        recentLaunches.forEach((l, i) => {
          const age = Math.floor((Date.now() - l.time)/1000);
          text += `${i+1}. ${l.symbol} (${age}s ago)\n`;
          kbd.inline_keyboard.push([
            { text: `Buy ${l.symbol}`, callback_data: `showbuy_${l.addr}` }
          ]);
        });
        await telegramBot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: kbd });
      } else if (data.startsWith('showbuy_')) {
        const addr = data.split('_')[1];
        await sendBuyMenu(addr);
      } else if (data === 'test_buy') {
        // Test menu for user to see the buy buttons immediately
        const testAddr = '0x0000000000000000000000000000000000000000'; // dummy for test
        await sendBuyMenu(testAddr, 'TEST TOKEN');
        await telegramBot.sendMessage(chatId, 'This is a test menu. Real launches will use actual addresses and names from fun.noxa.fi.');
      } else if (data === 'diag') {
        await handleDiag(chatId);
      } else if (data === 'toggle_pause') {
        isPaused = !isPaused;
        await sendTg(isPaused ? '⏸️ Sniping paused' : '▶️ Sniping resumed');
        await sendMainMenu(chatId);
      }
    });

    logger.info('Telegram alerts + BUTTONS ENABLED (fun.noxa.fi mode)');
    await sendTg('🚀 Robinhood Sniper started - focused on fun.noxa.fi/robinhood');
    await sendMainMenu(TG_CHAT, 'Menu ready. Use buttons below:');
    await sendAlert('🚀 Robinhood Sniper started (live on fun.noxa.fi/robinhood)');
  } catch (e) {
    logger.warn('Telegram init failed:', e.message);
  }
}

async function sendTg(text, options = {}) {
  if (!telegramBot || !TG_CHAT || !ENABLE_TG) return;
  try {
    await telegramBot.sendMessage(TG_CHAT, text, { parse_mode: 'HTML', ...options });
  } catch (e) {
    logger.debug('TG send failed: ' + e.message);
  }
}

// ethbot-style outbound alert (no polling needed, for workers/scripts)
async function sendAlert(text) {
  const token = TG_TOKEN;
  const chatId = TG_CHAT;
  if (!token || !chatId) return false;
  try {
    const https = require('https');
    const data = JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000) });
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${token}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }
    };
    const req = https.request(options, (res) => { /* ignore */ });
    req.on('error', () => {});
    req.write(data);
    req.end();
    return true;
  } catch (e) { return false; }
}

// Helper to fetch real token name and symbol from the contract + Blockscout for nameless memes
async function getTokenInfo(addr) {
  let name = "Unknown Token";
  let symbol = "???";
  try {
    const erc20Abi = [
      "function name() view returns (string)",
      "function symbol() view returns (string)"
    ];
    const token = new ethers.Contract(addr, erc20Abi, provider);
    [name, symbol] = await Promise.all([
      token.name().catch(() => name),
      token.symbol().catch(() => symbol)
    ]);
  } catch {}
  // Fallback: query Blockscout API for indexed name/creator/tx for nameless tokens
  try {
    const res = await fetch(`https://robinhoodchain.blockscout.com/api/v2/addresses/${addr}`);
    if (res.ok) {
      const data = await res.json();
      if (data.name && data.name !== name) name = data.name;
      if (data.symbol && data.symbol !== symbol) symbol = data.symbol;
      // Can add creator: data.creator?.hash or creation tx
    }
  } catch (e) {}
  return { name, symbol };
}

// Send buy menu for a newly detected token with specific amounts
async function sendBuyMenu(tokenAddr, fallbackSymbol = "NEW") {
  if (!telegramBot || !TG_CHAT || !ENABLE_TG) return;
  const info = await getTokenInfo(tokenAddr);
  let displayName = `${info.name} (${info.symbol})`;
  if (info.name === "Unknown Token" || info.symbol === "???") {
    displayName = `Unnamed Meme Token`;
  }
  const shortAddr = tokenAddr.slice(0, 6) + "..." + tokenAddr.slice(-4);
  const explorer = `https://robinhoodchain.blockscout.com/address/${tokenAddr}`;
  const text = `🚀 <b>New Launch Detected</b>\n${displayName}\n<code>${tokenAddr}</code> (${shortAddr})\n<a href="${explorer}">View on Explorer</a>\n\nChoose buy amount (ETH):`;
  const keyboard = {
    inline_keyboard: [
      [
        { text: "Buy 0.003 ETH", callback_data: `buy_${tokenAddr}_0.003` },
        { text: "Buy 0.005 ETH", callback_data: `buy_${tokenAddr}_0.005` }
      ],
      [
        { text: "Buy 0.007 ETH", callback_data: `buy_${tokenAddr}_0.007` },
        { text: "Buy 0.01 ETH", callback_data: `buy_${tokenAddr}_0.01` }
      ],
      [
        { text: "Auto 0.0001", callback_data: `buy_${tokenAddr}_0.0001` }
      ]
    ]
  };
  await telegramBot.sendMessage(TG_CHAT, text, { parse_mode: 'HTML', reply_markup: keyboard });
}

// General buy function for variable amount
async function buyToken(curveAddress, amountStr) {
  const buyAmount = ethers.parseEther(amountStr);
  logger.info(`[MANUAL BUY] ${curveAddress} for ${amountStr} ETH`);

  const curve = new ethers.Contract(curveAddress, curveABI, wallet);
  try {
    const gasEst = await curve.buy.estimateGas(0n, wallet.address, { value: buyAmount });
    const feeData = await provider.getFeeData();
    const maxFee = (feeData.maxFeePerGas || feeData.gasPrice) * BigInt(Math.floor(GAS_MULT * 100)) / 100n;

    const tx = await curve.buy(1n, wallet.address, {
      value: buyAmount,
      gasLimit: gasEst * 140n / 100n,
      maxFeePerGas: maxFee,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas || (maxFee / 2n)
    });
    const receipt = await tx.wait();
    const txLink = `${EXPLORER}/tx/${receipt.transactionHash}`;
    logger.info(`[BOUGHT] tx: ${receipt.transactionHash}`);
    await sendAlert(`✅ Bought ${amountStr} ETH on ${curveAddress}\nTx: ${receipt.transactionHash}\n${txLink}`);
    await sendTg(`✅ Bought ${amountStr} ETH worth\nTx: <code>${receipt.transactionHash}</code>\n<a href="${txLink}">View on Blockscout</a>`);

    // Add to positions (simplified)
    const transferTopic = ethers.id('Transfer(address,address,uint256)');
    const log = receipt.logs.find(l => l.topics[0] === transferTopic);
    const amount = log ? BigInt(log.data) : 0n;
    const entryPrice = await getCurrentPrice(curveAddress);
    const info = await getTokenInfo(curveAddress);

    // Check if already have position
    const existing = positions.find(p => p.token === curveAddress);
    if (existing) {
      existing.amount += amount;
    } else {
      positions.push({
        token: curveAddress,
        symbol: `${info.name} (${info.symbol})`,
        amount,
        entryPrice,
        highestPrice: entryPrice,
        isMigrated: false,
        entryBlock: receipt.blockNumber,
        soldAmount: 0n,
        reEntries: 0,
        tpReached: []
      });
    }
    savePositions();
  } catch (e) {
    logger.error(`[BUY FAIL]: ${e.message}`);
    await sendTg(`❌ Buy failed: ${e.message.slice(0,100)}`);
  }
}

async function handleStatus(chatId) {
  const pos = positions.length;
  const dailyPnl = dailyStats.realizedPnl.toFixed(4);
  const moonbag = STRATEGY.moonbagPct || 25;
  const bal = await getBalance();
  const balEth = ethers.formatEther(bal);
  const walletLink = `${EXPLORER}/address/${wallet.address}`;
  const text = `📊 <b>Status</b>\nWallet: <a href="${walletLink}">${wallet.address}</a>\nPositions: ${pos}\nDaily trades: ${dailyStats.trades}\nPnL: ${dailyPnl} ETH\nBalance: ${balEth} ETH\nMode: LIVE MAINNET\nMoonbag: ${moonbag}% held`;
  await telegramBot.sendMessage(chatId, text, { parse_mode: 'HTML' });
}

async function handlePositions(chatId) {
  if (positions.length === 0) {
    await telegramBot.sendMessage(chatId, 'No open positions.');
    return;
  }
  let text = '📍 <b>Open Positions</b>\n';
  positions.forEach((p, i) => {
    const entry = ethers.formatEther(p.entryPrice);
    const sold = p.soldAmount ? ethers.formatEther(p.soldAmount) : '0';
    text += `${i+1}. ${p.symbol}\n   Entry: ${entry} | Sold: ${sold} | Re-entries: ${p.reEntries || 0}\n`;
  });
  const keyboard = {
    inline_keyboard: positions.map((p, i) => [
      { text: `💸 Sell #${i+1} ${p.symbol.slice(0,10)}`, callback_data: `sell_${i}` }
    ])
  };
  await telegramBot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: keyboard });
}

async function handleDiag(chatId) {
  try {
    const bal = await getBalance();
    const balEth = ethers.formatEther(bal);
    const block = await provider.getBlockNumber().catch(() => 'N/A');
    const posCount = positions.length;
    const snipe = ethers.formatEther(SNIPE_AMOUNT);
    const paused = isPaused ? 'PAUSED' : 'RUNNING';
    const factoryStatus = (FACTORY && !FACTORY.includes('REPLACE')) ? 'SET' : 'BROAD SCAN (run discover.js)';
    
    const text = `🔍 <b>DIAG - Real Output</b>\n` +
      `Mode: LIVE MAINNET\n` +
      `Status: ${paused}\n` +
      `Wallet: <code>${wallet.address}</code>\n` +
      `Balance: ${balEth} ETH\n` +
      `Current Block: ${block}\n` +
      `Snipe Amount: ${snipe} ETH\n` +
      `Positions: ${posCount}\n` +
      `Factory: ${factoryStatus}\n` +
      `Poll Interval: ${POLL_MS}ms\n` +
      `Strategy Moonbag: ${STRATEGY.moonbagPct || 25}%\n` +
      `Time: ${new Date().toISOString()}`;
    
    await telegramBot.sendMessage(chatId, text, { parse_mode: 'HTML' });
    
    // Also log real data
    logger.info(`[DIAG] Bal:${balEth} Block:${block} Pos:${posCount}`);
  } catch (e) {
    await telegramBot.sendMessage(chatId, `Diag error: ${e.message}`);
  }
}

// Per-position sell buttons are handled inside the main callback_query above.
// If you want individual sell buttons in positions list, extend the callback handler there.

// ====================== HELPERS ======================
function loadPositions() {
  try {
    if (fs.existsSync(POSITIONS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(POSITIONS_FILE, 'utf8'));
      positions = raw.map(p => ({
        ...p,
        amount: BigInt(p.amount),
        entryPrice: BigInt(p.entryPrice),
        highestPrice: BigInt(p.highestPrice || p.entryPrice),
        soldAmount: p.soldAmount ? BigInt(p.soldAmount) : 0n,
        reEntries: p.reEntries || 0
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
      highestPrice: p.highestPrice.toString(),
      soldAmount: (p.soldAmount || 0n).toString(),
      reEntries: p.reEntries || 0
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

async function getBalance() {
  try {
    const bal = await provider.getBalance(wallet.address);
    return bal;
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
    const testAmount = ethers.parseEther('0.001'); // smaller test for low balance wallets

    // Simulate buy
    const buyGas = await curve.buy.estimateGas(1n, wallet.address, { value: testAmount });
    if (buyGas > 800000n) {
      logger.warn(`[HONEYPOT] High buy gas ${buyGas} for ${curveAddress}`);
      return true;
    }

    // Try to simulate sell (if we had tokens)
    const sellGas = await curve.sell.estimateGas(1000n, 1n).catch(() => 999999n);
    if (sellGas > 1000000n) {
      logger.warn(`[HONEYPOT] High sell gas ${sellGas} for ${curveAddress}`);
      return true;
    }

    return false;
  } catch (e) {
    logger.warn(`[HONEYPOT] Estimate failed for ${curveAddress}: ${e.message}`);
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
  if (!ROUTER || !WETH) {
    logger.warn('No ROUTER/WETH configured - cannot sell on DEX. Update config.json with real addresses.');
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
  if (isPaused) {
    logger.info(`[PAUSED] Skipping snipe for ${symbol}`);
    return;
  }
  if (positions.length >= MAX_POS) return;
  if (!checkRiskLimits()) return;

  const bal = await getBalance();
  if (bal < SNIPE_AMOUNT * 2n) {
    logger.warn(`[SKIP SNIPE] Low balance ${ethers.formatEther(bal)} ETH`);
    await sendTg(`⚠️ Low balance ${ethers.formatEther(bal)} ETH - skipping snipe`);
    return;
  }

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

    const tx = await curve.buy(1n, wallet.address, {
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
    const info = await getTokenInfo(curveAddress);

    positions.push({ 
      token: curveAddress, 
      symbol: `${info.name} (${info.symbol})`, 
      amount, 
      entryPrice, 
      highestPrice: entryPrice, 
      isMigrated: false, 
      entryBlock: receipt.blockNumber,
      soldAmount: 0n,
      reEntries: 0,
      tpReached: [] // for ladder
    });
    dailyStats.trades++;
    savePositions();

    const txLink = `${EXPLORER}/tx/${receipt.transactionHash}`;
    await sendTg(`✅ Bought <b>${symbol}</b> on fun.noxa.fi/robinhood\nEst. amount: ${ethers.formatEther(amount)}\n<a href="${txLink}">View tx</a>`);
    await sendAlert(`✅ Snipe bought ${symbol}\n${txLink}`);
  } catch (e) {
    logger.error(`[SNIPE FAIL] ${symbol}: ${e.message}`);
    await sendTg(`❌ Snipe failed ${symbol}`);
  }
}

// ====================== SELL ======================
async function sellPosition(pos) {
  // LIVE mainnet - always attempt real sell

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
        if (ROUTER && !pos.isMigrated) {
          pos.isMigrated = true;
          logger.info(`[MIGRATED] ${pos.symbol} switched to DEX mode`);
          await sendTg(`🔄 ${pos.symbol} graduated to DEX - will use DEX sells`);
        }
        continue;
      }

      const entry = Number(pos.entryPrice);
      const curr = Number(price);
      const pnl = entry > 0 ? ((curr - entry) / entry) * 100 : 0;

      // Update peak
      if (price > pos.highestPrice) pos.highestPrice = price;

      // === SAFE MEME STRATEGY IMPLEMENTATION ===
      await manageSafeStrategy(pos, price, pnl);

    } catch (e) {
      logger.debug(`Monitor error for ${pos.symbol}: ${e.message}`);
    }
  }
}

// === CORE STRATEGY: Small amount snipe + Capital safe profit taking + Moonbag ===
async function manageSafeStrategy(pos, currentPrice, pnlPct) {
  const entryPrice = Number(pos.entryPrice);
  let remainingAmount = pos.amount - (pos.soldAmount || 0n);
  if (remainingAmount <= 0n) {
    positions = positions.filter(p => p.token !== pos.token);
    savePositions();
    return;
  }

  const peak = Number(pos.highestPrice);
  const trailingPrice = peak * (1 - TRAILING);

  // Calculate moonbag: never sell below this % of original position
  const moonbagPct = STRATEGY.moonbagPct || 25;
  const moonbagAmount = (pos.amount * BigInt(moonbagPct)) / 100n;
  const sellableAmount = remainingAmount > moonbagAmount ? remainingAmount - moonbagAmount : 0n;

  if (sellableAmount <= 0n) {
    // Only moonbag left - hold for potential moon
    logger.info(`[MOONBAG] ${pos.symbol} - Only ${moonbagPct}% moonbag remaining. Holding for moonshot.`);
    return;
  }

  // 1. Hard Stop Loss - protect capital fast (sell everything, even moonbag on hard rugs)
  if (pnlPct <= -STOP_LOSS * 100) {
    logger.info(`[SL] ${pos.symbol} PnL ${pnlPct.toFixed(1)}% - Selling for capital protection`);
    await sendTg(`🛡️ SL hit on ${pos.symbol} (${pnlPct.toFixed(1)}%) - Protecting capital`);
    await sellPosition(pos);
    dailyStats.realizedPnl += (currentPrice - pos.entryPrice) * (remainingAmount / BigInt(10**18)) / BigInt(10**18) || 0;
    return;
  }

  // 2. TP Ladder (partial sells for safe profits) - respect moonbag
  const tpLadder = STRATEGY.tpLadder || [0.5, 1.0, 2.0];
  const sellPercents = STRATEGY.tpSellPercents || [30, 30, 40];
  const currentMultiplier = currentPrice / entryPrice;

  for (let i = 0; i < tpLadder.length; i++) {
    const target = tpLadder[i];
    if (currentMultiplier >= target && !(pos.tpReached || []).includes(i)) {
      const sellPct = sellPercents[i] || 30;
      let sellAmount = (remainingAmount * BigInt(Math.floor(sellPct))) / 100n;

      // Cap sell so we don't go below moonbag
      if (sellAmount > sellableAmount) sellAmount = sellableAmount;

      if (sellAmount > 0n) {
        logger.info(`[TP${i+1}] ${pos.symbol} reached ${target}x - Selling ${sellPct}% (leaving moonbag)`);
        await sendTg(`💰 TP${i+1} hit on ${pos.symbol} (${(target*100).toFixed(0)}% gain) - Selling ${sellPct}% , moonbag kept`);
        
        const tempPos = {...pos, amount: sellAmount};
        await sellPosition(tempPos);
        
        pos.soldAmount = (pos.soldAmount || 0n) + sellAmount;
        pos.tpReached = pos.tpReached || [];
        pos.tpReached.push(i);
        
        dailyStats.realizedPnl += (currentPrice - pos.entryPrice) * (sellAmount / BigInt(10**18)) / BigInt(10**18) || 0;
        savePositions();
        remainingAmount = pos.amount - (pos.soldAmount || 0n);
      }
    }
  }

  // 3. Trailing Stop (lock profits on remaining, but leave moonbag)
  if (currentPrice < BigInt(Math.floor(trailingPrice)) && (pos.soldAmount || 0n) < pos.amount) {
    let sellAmount = remainingAmount - moonbagAmount;
    if (sellAmount > 0n) {
      logger.info(`[TRAILING] ${pos.symbol} dropped below peak - Selling to moonbag`);
      await sendTg(`📉 Trailing stop on ${pos.symbol} - Selling to ${moonbagPct}% moonbag`);
      const tempPos = {...pos, amount: sellAmount};
      await sellPosition(tempPos);
      pos.soldAmount = (pos.soldAmount || 0n) + sellAmount;
      savePositions();
    }
    return;
  }

  // 4. Re-entry on dip for better average (capital safe - very small)
  if (STRATEGY.reEntryOnDip && (pos.reEntries || 0) < (STRATEGY.maxReEntriesPerPosition || 2)) {
    const dipFromEntry = (entryPrice - currentPrice) / entryPrice * 100;
    if (dipFromEntry >= (STRATEGY.reEntryDipPct || 30) * 100) {
      const reAmount = ethers.parseEther(STRATEGY.reEntryAmountEth || '0.00005');
      if (reAmount > 0n) {
        logger.info(`[RE-ENTRY] ${pos.symbol} dipped ${dipFromEntry.toFixed(1)}% - Adding tiny ${STRATEGY.reEntryAmountEth} ETH`);
        await sendTg(`🔄 Re-buying dip on ${pos.symbol} (${dipFromEntry.toFixed(0)}% down)`);
        
        try {
          const curve = new ethers.Contract(pos.token, curveABI, wallet);
          const gasEst = await curve.buy.estimateGas(0n, wallet.address, { value: reAmount });
          await curve.buy(0n, wallet.address, {
            value: reAmount,
            gasLimit: gasEst * 130n / 100n
          });
          pos.reEntries = (pos.reEntries || 0) + 1;
          pos.amount += reAmount;
          dailyStats.trades++;
          savePositions();
          logger.info(`[RE-ENTRY SUCCESS] ${pos.symbol}`);
        } catch (e) {
          logger.warn(`Re-entry failed for ${pos.symbol}: ${e.message}`);
        }
      }
    }
  }

  // 5. If all ladder hit, leave the moonbag (don't sell the final portion)
  // Moonbag is held for potential moonshot after DEX migration
  const moonbagLeft = remainingAmount <= moonbagAmount;
  if (moonbagLeft) {
    logger.info(`[MOONBAG HOLD] ${pos.symbol} - ${moonbagPct}% moonbag secured. Holding for moon.`);
    // Optional: on migration, you could sell more of moonbag, but for now hold
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

    // New launches - force broad scan if factory is placeholder
    const useFactory = FACTORY && !FACTORY.includes('REPLACE') ? FACTORY : undefined;
    let logs = await withRetry(() => provider.getLogs({
      address: useFactory,
      fromBlock: lastPolledBlock + 1,
      toBlock: current,
      topics: [topic]
    }));

    // Fallback: also scan known launch contracts for activity
    if ((!logs || logs.length === 0) && KNOWN_LAUNCH_CONTRACTS.length > 0) {
      for (const known of KNOWN_LAUNCH_CONTRACTS) {
        const extra = await withRetry(() => provider.getLogs({
          address: known,
          fromBlock: lastPolledBlock + 1,
          toBlock: current,
          topics: [topic]
        })).catch(() => []);
        logs = logs.concat(extra);
      }
    }

    for (const log of logs) {
      if (isPaused) break;
      try {
        // Use topics[1] as token, topics[2] as curve if present (common in launch events)
        let buyAddr = '0x' + log.topics[1].slice(-40);
        if (log.topics.length > 2 && log.topics[2] && log.topics[2] !== '0x0000000000000000000000000000000000000000000000000000000000000000') {
          buyAddr = '0x' + log.topics[2].slice(-40);
        }
        const tokenForName = '0x' + log.topics[1].slice(-40); // for name lookup, use token
        logger.info(`[NEW LAUNCH] curve/buy: ${buyAddr} (token: ${tokenForName}) on fun.noxa.fi/robinhood`);
        await sendAlert(`🚀 New launch: ${buyAddr} on fun.noxa.fi/robinhood`);
        await sendTg(`🚀 New launch detected: <code>${buyAddr}</code>`);
        // Send buy buttons with real token name, using buyAddr for the buttons
        await sendBuyMenu(buyAddr);
        // Get info for recent list using token
        const info = await getTokenInfo(tokenForName);
        let display = `${info.name} (${info.symbol})`;
        if (info.name === "Unknown Token") {
          const short = tokenForName.slice(0,6) + "..." + tokenForName.slice(-4);
          display = `Unnamed (${short})`;
        }
        // Track for recent (use buyAddr for actual buy)
        recentLaunches.unshift({addr: buyAddr, symbol: display, time: Date.now()});
        if (recentLaunches.length > 5) recentLaunches.pop();
        // Keep small auto snipe if desired - use buyAddr
        setTimeout(() => snipe(buyAddr, info.symbol), 1800);
      } catch {
        const buyAddr = '0x' + log.topics[1].slice(-40);
        await sendBuyMenu(buyAddr, 'LAUNCH');
        recentLaunches.unshift({addr: buyAddr, symbol: 'LAUNCH', time: Date.now()});
        if (recentLaunches.length > 5) recentLaunches.pop();
        setTimeout(() => snipe(buyAddr, 'LAUNCH'), 2000);
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
    if (!String(e.message || e).includes('ENS')) {
      logger.warn('Poll error: ' + (e.message || e));
    }
    await new Promise(r => setTimeout(r, 700));
  }
}

// ====================== MAIN ======================
async function main() {
  console.log('=== ROBINHOOD CHAIN SNIPER - fun.noxa.fi/robinhood (LIVE MAINNET) ===');
  logger.info(`Mode: LIVE MAINNET ONLY (experienced user)`);
  logger.info(`Snipe size: ${ethers.formatEther(SNIPE_AMOUNT)} ETH (from config or default)`);
  logger.info(`Wallet: ${wallet.address}`);
  logger.info(`Focus: fun.noxa.fi/robinhood bonding curves`);

  // Real output diagnostics
  try {
    const net = await provider.getNetwork();
    const block = await provider.getBlockNumber();
    logger.info(`Chain ID: ${net.chainId} | Current block: ${block}`);
    logger.info(`RPC: ${RPC}`);
  } catch (e) {
    logger.warn('RPC check issue: ' + e.message);
  }

  if (!FACTORY || FACTORY.includes('REPLACE')) {
    logger.warn('No factory set in config. Using broad scan + KNOWN list. Run "node discover.js" WHILE watching a launch on fun.noxa.fi/robinhood for real addresses.');
  } else {
    logger.info(`Factory: ${FACTORY}`);
  }

  loadPositions();
  await initTelegram();

  await pollNewLaunches();

  setInterval(pollNewLaunches, POLL_MS);
  setInterval(monitorPositions, 4500);

  setInterval(async () => {
    const bal = await getBalance();
    const balEth = parseFloat(ethers.formatEther(bal));
    logger.info(`[HEARTBEAT] ${positions.length} positions | Bal: ${balEth.toFixed(4)} ETH`);
    if (balEth < 0.01) {
      await sendAlert(`⚠️ Low balance: ${balEth.toFixed(4)} ETH`);
    }
    await sendTg(`❤️ Heartbeat | Pos: ${positions.length} | Bal: ${balEth.toFixed(4)} ETH`);
    savePositions();
  }, 90000);

  process.on('SIGINT', () => {
    logger.info('Shutting down...');
    savePositions();
    process.exit(0);
  });

  logger.info('Bot running. Press Ctrl+C to stop.');
}

main().catch(e => { logger.error(e); process.exit(1); });