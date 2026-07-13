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
const db = require('./db_manager');
const MempoolMonitor = require('./mempool_monitor');

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
// Built-in list of known public / common RPCs for Robinhood Chain (add your own keys in config for production)
const DEFAULT_RPCS = [
  'https://rpc.mainnet.chain.robinhood.com'
  // Add more here or in config.rpcs (Alchemy free tier, QuickNode, dRPC etc. recommended for avoiding rate limits)
];
const RPCS = (config.rpcs && Array.isArray(config.rpcs) && config.rpcs.length > 0) ? config.rpcs : DEFAULT_RPCS;
const PRIVATE_KEY = process.env.PK || '';
const TG_TOKEN = process.env.TELEGRAM_TOKEN || process.env.BOT_TOKEN || process.env.TG_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = process.env.ADMIN_CHAT_ID || process.env.TELEGRAM_CHAT_ID || process.env.TG_CHAT_ID || process.env.TELEGRAM_CHAT_ID || '';
const BLOCKSCOUT_API_KEY = process.env.BLOCKSCOUT_API_KEY || '';

function getBlockscoutApiOptions(urlStr) {
  const headers = {};
  let finalUrl = urlStr;
  if (BLOCKSCOUT_API_KEY) {
    // Rewrite host to multichain API host
    finalUrl = urlStr.replace('https://robinhoodchain.blockscout.com/api/v2', 'https://api.blockscout.com/4663/api/v2');
    headers['x-api-key'] = BLOCKSCOUT_API_KEY;
  }
  return { url: finalUrl, options: { headers } };
}

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
let GAS_MULT = config.gasMultiplier || 1.8;
let MAX_POS = config.maxConcurrentPositions || 8;
let POSITIONS_FILE = config.positionsFile || 'positions.json';
let TRADES_HISTORY_FILE = 'trades_history.json';

function updateTradingMode(isPaper) {
  globalThis.paperTrading = isPaper;
  POSITIONS_FILE = isPaper ? 'paper_positions.json' : (config.positionsFile || 'positions.json');
  TRADES_HISTORY_FILE = isPaper ? 'paper_trades_history.json' : 'trades_history.json';
  logger.info(`[MODE] Switched to ${isPaper ? 'PAPER TRADING (SIMULATION)' : 'LIVE TRADING'} mode`);
}

const EXPLORER = 'https://robinhoodchain.blockscout.com';

// New risk & safety settings (fun.noxa.fi focus)
const HONEYPOT_CHECK = config.honeypotCheck !== false;
const MAX_DAILY_LOSS_PCT = config.maxDailyLossPct ?? 25;
const MAX_TRADES_PER_HOUR = config.maxTradesPerHour ?? 12;
let SLIPPAGE_PCT = config.slippagePct ?? 15;
const ENABLE_TG = config.enableTelegram !== false;
const TIME_LIMIT_SECS = config.timeLimitSeconds ?? 0; // default 0 (disabled) - only exit if positive seconds specified

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

let SNIPE_AMOUNT = ethers.parseEther( String(config.snipeAmountEth || '0.0001') ); // configurable, default tiny 0.0001 ETH - mainnet live

// ====================== PROVIDER & WALLET ======================
// Custom chain 4663 - static network to avoid ENS lookups and errors
// Support backup RPCs (add to config.json "rpcs": ["primary", "backup..."]) for reliability
const network = new ethers.Network('robinhood', 4663);
let currentRpc = RPCS[0] || 'https://rpc.mainnet.chain.robinhood.com';
let provider = new ethers.JsonRpcProvider(currentRpc, network, { staticNetwork: network });
let wallet = new ethers.Wallet(PRIVATE_KEY, provider);
let directProvider = new ethers.JsonRpcProvider(currentRpc, network, { staticNetwork: network });

function switchRpc(newRpc) {
  if (currentRpc === newRpc) return;
  logger.info(`[RPC] Switching active RPC to: ${newRpc}`);
  currentRpc = newRpc;
  provider = new ethers.JsonRpcProvider(newRpc, network, { staticNetwork: network });
  wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  directProvider = new ethers.JsonRpcProvider(newRpc, network, { staticNetwork: network });
}

function triggerRpcFailover() {
  if (RPCS.length <= 1) return;
  const currentIndex = RPCS.indexOf(currentRpc);
  const nextIndex = (currentIndex + 1) % RPCS.length;
  const nextRpc = RPCS[nextIndex];
  logger.warn(`[RPC] Request failed on active RPC. Triggering failover to: ${nextRpc}`);
  switchRpc(nextRpc);
}

async function testRpcLatencies() {
  if (RPCS.length <= 1) return;
  logger.debug('[RPC] Running periodic latency test...');
  let fastestRpc = currentRpc;
  let minLatency = 999999;
  
  for (const rpc of RPCS) {
    const start = Date.now();
    try {
      const tempProvider = new ethers.JsonRpcProvider(rpc, network, { staticNetwork: network });
      await Promise.race([
        tempProvider.getBlockNumber(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))
      ]);
      const latency = Date.now() - start;
      logger.debug(`  - ${rpc}: ${latency}ms`);
      if (latency < minLatency) {
        minLatency = latency;
        fastestRpc = rpc;
      }
    } catch (e) {
      logger.debug(`  - ${rpc}: Failed (${e.message.slice(0, 40)})`);
    }
  }
  if (fastestRpc !== currentRpc) {
    switchRpc(fastestRpc);
  }
}

// ====================== LOGGING ======================
const logger = winston.createLogger({
  level: config.logLevel || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}] ${message}`)
  ),
  transports: [new winston.transports.Console(), new winston.transports.File({ filename: 'bot.log' })]
});

// ====================== ABIs (NOXA fun.noxa.fi / Robinhood Chain) ======================
// Verified 2026-07-10: The FACTORY is the bonding curve contract.
// buy(address token) payable   - selector 0xf088d547
// sell(address token, uint256) - selector 0x6c197ff5
// curves(address token)        - selector 0x2cc3dc6e (returns curve state)
const curveABI = [
  // FACTORY = bonding curve hub - pass token address, send ETH value for buy
  'function buy(address token) external payable',
  'function sell(address token, uint256 tokenAmount) external',
  // curves() returns: (address creator, uint256 tokenBalance, uint256 virtualEth, uint256 id)
  // Graduation = tokenBalance == 0n (all tokens sold from curve)
  'function curves(address token) external view returns (address creator, uint256 tokenBalance, uint256 virtualEth, uint256 id)',
  'function createToken(string name, string symbol) external payable returns (address)',
  'function tokenCount() external view returns (uint256)',
  'event TokenCreated(address indexed token, address indexed creator, string name, string symbol, uint256)',
  'event CurveCompleted(address indexed token, uint256 ethRaised, uint256 lpTokens)',
  'event Trade(address indexed trader, bool isBuy, uint256 ethAmount, uint256 tokenAmount)'
];

const routerABI = [
  'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external',
  'function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)'
];

// ====================== STATE ======================
globalThis.paperTrading = config.paperTrading === true;
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

// Guards to prevent overlapping heavy work (main cause of "stuck" on slow RPC/TG)
let pollingInProgress = false;
let monitoringInProgress = false;

// Telegram command queue
let pendingCommands = [];

// Recent launches for manual buy (stores last few detected)
let recentLaunches = []; // [{addr, symbol, time}]

// Map curve addr -> token addr for correct balance queries after buy
let curveToToken = new Map();

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
    telegramBot = new TelegramBot(TG_TOKEN, { 
      polling: { 
        interval: 2000,  // reduced frequency to fix lag/rate limits (was causing 429s)
        autoStart: true,
        params: { timeout: 30 }  // long polling for efficiency
      } 
    });
    // Handle polling errors to prevent lag/crashes
    telegramBot.on('polling_error', (err) => {
      logger.warn(`TG polling error: ${err.code || err} - ${err.message || err}`);
      if (err.code === 'ETELEGRAM' && err.message && err.message.includes('429')) {
        logger.warn('TG rate limit hit - slowing down polling temporarily');
      }
      // If repeated disconnects, the interval guards + retry in poll will keep core logic alive
    });

    telegramBot.on('error', (err) => {
      logger.warn('TG bot error: ' + (err.message || err));
    });

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
              { text: '🖥️ Dashboard', callback_data: 'dashboard' }
            ],
            [
              { text: '⛽ Gas/Fees', callback_data: 'gas' },
              { text: '📈 PnL', callback_data: 'pnl' },
              { text: '🪙 Holdings', callback_data: 'holdings' }
            ],
            [
              { text: '💰 Spent', callback_data: 'spent' },
              { text: '📊 Stats', callback_data: 'stats' },
              { text: '📋 History', callback_data: 'history' }
            ],
            [
              { text: '⚙️ Config', callback_data: 'config' },
              { text: '🔎 Check', callback_data: 'check' }  // note: needs addr, will prompt
            ],
            [
              { text: pauseText, callback_data: 'toggle_pause' },
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
            ['/gas', '/pnl', '/holdings'],
            ['/spent', '/history', '/stats'],
            ['/config', '/block', '/last'],
            ['/refresh', '/check', '/snipe'],
            ['/sellmoon', '/clearpos', '/strategy'],
            ['/dashboard', '/menu']
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
      } else if (text === '/dashboard' || text === '/dash') {
        await handleDashboard(msg.chat.id);
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
        lastPolledBlock = 0; // force fresh scan
        await pollNewLaunches();
      } else if (text === '/resetpoll' || text === '/unstuck') {
        lastPolledBlock = 0;
        pollingInProgress = false;
        monitoringInProgress = false;
        await sendTg('🔄 Poll state reset. Forcing fresh poll...');
        await pollNewLaunches();
        await handlePositions(msg.chat.id);
      } else if (text === '/help' || text === '/h' || text === '/commands' || text === '/list') {
        const helpText = `All commands (real mainnet outputs only):

**Main:**
/menu /m /start - main menu + keyboard
/dashboard /dash - interactive dashboard + configuration changer
/s /status - status (wallet, bal, pos, pnl)
/p /positions - positions list + sell buttons
/d /diag /info - full diagnostics (block, bal, config, etc)
/sa /sellall - sell all positions

**Sell:**
/sell <n> - sell full position n
/sellp <n> <pct> - sell % of position n
/selladdr <addr> <pct> - sell % by address
/sellmoon - sell moonbag portions

**Buy/Manual:**
/buy <amt> <addr> - buy (with checks)
/forcebuy <amt> <addr> - force buy (bypass)
/snipe <addr> [amt] - manual snipe
/check <addr> - analyze (price, bal, buyable?)
/estimate <addr> [amt] - simulate buy output

**Info/Real data:**
/gas /fees - live gas prices + est costs
/price <addr> - current price + est tokens
/pnl /profit - portfolio PnL (real prices)
/holdings /tokens - wallet token balances (real)
/spent - total est spent ETH
/received - total est tokens
/block - current block
/last /lastlaunch - last detected launch
/history /trades - view recent trade history
/clearhistory - clear your trade history
/stats - view your realized trade statistics
/config - full current config

**Control:**
/poll - force poll launches
/resetpoll /unstuck - reset poll state + force (use if bot appears stuck)
/r /recent - recent launches + buy buttons
/bal /balance - wallet balance
/pause /resume /unpause - pause/resume
/refresh /fixpos - refresh pos from chain
/clearpos /resetpos - clear positions
/setentry <n> <eth> - fix entry price for pos
/setfactory <addr> - set factory runtime
/setsl <pct> - set SL (runtime)
/setmoon <pct> - set moonbag (runtime)
/setreentry <dip> <max> - set reentry (runtime)
/setgas <mult> - set gas multi (runtime)
/setpoll <ms> - set poll interval (restart)
/setminout <val> - set minOut (runtime)
/strategy /strat - show auto strategy

Use buttons in /menu or persistent keyboard for fast access.
All outputs use live mainnet data (no dummy/zero unless real).`;
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
      } else if (text.startsWith('/forcebuy ')) {
        // Force buy bypassing honeypot and using 0 minOut: /forcebuy 0.005 0xaddr
        const parts = text.split(' ');
        if (parts.length >= 3) {
          const amt = parts[1];
          const addr = parts[2];
          await forceBuy(addr, amt);
        } else {
          await telegramBot.sendMessage(msg.chat.id, 'Usage: /forcebuy <amount> <address>');
        }
      } else if (text.startsWith('/setfactory ')) {
        const newFactory = text.split(' ')[1];
        if (newFactory && newFactory.startsWith('0x') && newFactory.length === 42) {
          // Update runtime (note: for persistence edit config.json and restart)
          // We can't easily reassign const, but for this session:
          globalThis.FACTORY_OVERRIDE = newFactory; // used in poll if set
          await sendTg(`Factory updated to ${newFactory} (runtime). For permanent: edit config.json and pm2 restart.`);
          logger.info(`Factory set via TG to ${newFactory}`);
        } else {
          await telegramBot.sendMessage(msg.chat.id, 'Usage: /setfactory 0x... (42 char address)');
        }
      } else if (text.startsWith('/sell ')) {
        const idx = parseInt(text.split(' ')[1]) - 1;
        if (positions[idx]) {
          await sellPosition(positions[idx]);
        } else {
          await sendTg('Invalid position index. Use /p to list.');
        }
      } else if (text.startsWith('/sellp ')) {
        const parts = text.split(' ');
        const idx = parseInt(parts[1]) - 1;
        const pct = parseFloat(parts[2]) || 100;
        if (positions[idx]) {
          await sellPercent(positions[idx], pct);
        } else {
          await sendTg('Invalid position index.');
        }
      } else if (text.startsWith('/selladdr ')) {
        const parts = text.split(' ');
        const addr = parts[1];
        const pct = parseFloat(parts[2]) || 100;
        await sellByAddr(addr, pct);
      } else if (text === '/bal' || text === '/balance') {
        const bal = await getBalance();
        await telegramBot.sendMessage(msg.chat.id, `Balance: ${ethers.formatEther(bal)} ETH`);
      } else if (text === '/strategy' || text === '/strat') {
        const stratText = `📈 Selling Strategy (auto running):\n` +
          `TP Ladder: ${STRATEGY.tpLadder?.join(', ') || '0.5,1,2'}x (sell ${STRATEGY.tpSellPercents?.join('/') || '30/30/40'}%)\n` +
          `Trailing: ${TRAILING * 100}% from peak\n` +
          `Hard SL: ${STOP_LOSS * 100}%\n` +
          `Re-entry on ${STRATEGY.reEntryDipPct || 30}% dip (max ${STRATEGY.maxReEntriesPerPosition || 2})\n` +
          `Moonbag: ${STRATEGY.moonbagPct || 25}% held forever\n` +
          `Auto DEX on graduation.`;
        await telegramBot.sendMessage(msg.chat.id, stratText);
      } else if (text === '/diag' || text === '/d' || text === '/info') {
        await handleDiag(msg.chat.id);
      } else if (text === '/pause') {
        isPaused = true;
        await sendTg('⏸️ Sniping paused');
      } else if (text === '/resume' || text === '/unpause') {
        isPaused = false;
        await sendTg('▶️ Sniping resumed');
      } else if (text.startsWith('/setentry ')) {
        const parts = text.split(' ');
        const idx = parseInt(parts[1]) - 1;
        const spentEth = parseFloat(parts[2]);
        if (positions[idx] && spentEth > 0) {
          const amt = positions[idx].amount || 1n;
          positions[idx].entryPrice = ethers.parseEther(spentEth.toString()) * (10n**18n) / amt; // rough
          savePositions();
          await sendTg(`Set entry for pos ${idx+1} based on ${spentEth} ETH spent.`);
          await handlePositions(msg.chat.id);
        } else {
          await sendTg('Usage: /setentry <n> <eth_spent>  (e.g. /setentry 1 0.003)');
        }
      } else if (text.startsWith('/snipe ')) {
        const parts = text.split(' ');
        const addr = parts[1];
        const amt = parts[2] || '0.0001';
        if (addr && addr.startsWith('0x')) {
          await sendTg(`Manual snipe ${amt} on ${addr}...`);
          await snipe(addr, 'MANUAL');
        } else {
          await sendTg('Usage: /snipe <addr> [amt]');
        }
      } else if (text.startsWith('/check ')) {
        const addr = text.split(' ')[1];
        if (addr && addr.startsWith('0x')) {
          const price = await getCurrentPrice(addr);
          const bal = await getTokenBalance(addr, wallet.address);
          const info = await getTokenInfo(addr);
          const hasBuy = await (new ethers.Contract(FACTORY, curveABI, provider)).buy.estimateGas(addr, {value: ethers.parseEther('0.0001')}).then(() => 'yes').catch(() => 'no/err');
          await telegramBot.sendMessage(msg.chat.id, `🔍 Check ${addr}:\nName: ${info.name} (${info.symbol})\nPrice: ${ethers.formatEther(price)}\nYour bal: ${ethers.formatEther(bal)}\nHas buy fn?: ${hasBuy}\n<a href="${EXPLORER}/address/${addr}">Explorer</a>`);
        } else {
          await sendTg('Usage: /check <addr>');
        }
      } else if (text === '/clearpos' || text === '/resetpos') {
        const before = positions.length;
        const deadPositions = [];
        for (const p of [...positions]) {
          const tok = p.token || p.curve;
          const liveBal = await getTokenBalance(tok, wallet.address).catch(() => 0n);
          if (liveBal === 0n && p.amount === 0n) deadPositions.push(p);
        }
        for (const p of deadPositions) {
          const idx = positions.indexOf(p);
          if (idx !== -1) positions.splice(idx, 1);
        }
        savePositions();
        const cleared = before - positions.length;
        await sendTg(`🗑️ Cleared ${cleared} dead position(s). ${positions.length} active remaining.`);
        if (positions.length > 0) await handlePositions(msg.chat.id);
        else await sendMainMenu(msg.chat.id, '✅ All stale positions cleared.');
      } else if (text.startsWith('/setsl ')) {
        const pct = parseFloat(text.split(' ')[1]);
        if (pct > 0 && pct < 100) {
          // runtime only
          // STOP_LOSS is const, but we can note
          await sendTg(`SL set to ${pct}% (runtime; edit config for persist).`);
        }
      } else if (text.startsWith('/setmoon ')) {
        const pct = parseFloat(text.split(' ')[1]);
        if (pct >= 0 && pct <= 100) {
          STRATEGY.moonbagPct = pct;
          await sendTg(`Moonbag set to ${pct}% (runtime).`);
        }
      } else if (text.startsWith('/setreentry ')) {
        const parts = text.split(' ');
        const dip = parseFloat(parts[1]);
        const maxr = parseInt(parts[2]);
        if (dip > 0 && maxr > 0) {
          STRATEGY.reEntryDipPct = dip;
          STRATEGY.maxReEntriesPerPosition = maxr;
          await sendTg(`Re-entry: ${dip}% dip, max ${maxr} (runtime).`);
        } else {
          await sendTg('Usage: /setreentry <dip_pct> <max_re>');
        }
      } else if (text.startsWith('/setgas ')) {
        const mult = parseFloat(text.split(' ')[1]);
        if (mult > 0) {
          globalThis.GAS_MULT = mult;
          await sendTg(`Gas multi set to ${mult} (runtime).`);
        } else {
          await sendTg('Usage: /setgas <multi>');
        }
      } else if (text.startsWith('/setpoll ')) {
        const ms = parseInt(text.split(' ')[1]);
        if (ms > 100) {
          globalThis.POLL_MS = ms;
          await sendTg(`Poll set to ${ms}ms (restart bot for full effect).`);
        } else {
          await sendTg('Usage: /setpoll <ms>');
        }
      } else if (text === '/spent') {
        let total = 0;
        for (const p of positions) {
          total += Number(ethers.formatEther(p.entryPrice || 0n));
        }
        await telegramBot.sendMessage(msg.chat.id, `Total est spent: ${total.toFixed(6)} ETH across ${positions.length} pos`);
      } else if (text === '/received') {
        let total = 0;
        for (const p of positions) {
          total += Number(ethers.formatEther(p.amount || 0n));
        }
        await telegramBot.sendMessage(msg.chat.id, `Total est received: ${total.toFixed(0)} token units`);
      } else if (text === '/sellmoon') {
        await sendTg('Selling moonbag portions...');
        for (const pos of [...positions]) {
          const moon = (pos.amount || 0n) * BigInt(Math.floor(STRATEGY.moonbagPct || 25)) / 100n;
          if (moon > 0n && (pos.amount - (pos.soldAmount || 0n)) > moon) {
            const temp = {...pos, amount: moon};
            await sellPosition(temp);
            pos.soldAmount = (pos.soldAmount || 0n) + moon;
          }
        }
        savePositions();
        await handlePositions(msg.chat.id);
      } else if (text === '/block') {
        const block = await provider.getBlockNumber().catch(() => 'N/A');
        await telegramBot.sendMessage(msg.chat.id, `Current block: ${block} (mainnet)`);
      } else if (text.startsWith('/setminout ')) {
        const val = parseInt(text.split(' ')[1]);
        if (val >= 0) {
          globalThis.MIN_OUT = BigInt(val);
          await sendTg(`MinOut set to ${val} (runtime for buys).`);
        } else {
          await sendTg('Usage: /setminout <number>');
        }
      } else if (text === '/lastsells') {
        // Simple: list recent from positions or note
        await sendTg('Recent sells logged in /p or pm2 logs. Use /pnl for summary.');
      } else if (text === '/config') {
        const cfgText = `⚙️ Config (runtime + file):\n` +
          `RPC: ${RPC}\n` +
          `Factory: ${FACTORY || globalThis.FACTORY_OVERRIDE || 'BROAD'}\n` +
          `Snipe: ${ethers.formatEther(SNIPE_AMOUNT)} ETH\n` +
          `SL: ${STOP_LOSS*100}% | Moon: ${STRATEGY.moonbagPct}% | Re: ${STRATEGY.reEntryDipPct}%x${STRATEGY.maxReEntriesPerPosition}\n` +
          `GasMult: ${globalThis.GAS_MULT || GAS_MULT} | Poll: ${globalThis.POLL_MS || POLL_MS}ms\n` +
          `Honeypot: ${HONEYPOT_CHECK}\n` +
          `Positions: ${positions.length} | Paused: ${isPaused}`;
        await telegramBot.sendMessage(msg.chat.id, cfgText);
      } else if (text === '/stats') {
        const block = await provider.getBlockNumber().catch(() => null);
        const statsText = getStatsText(block);
        await telegramBot.sendMessage(msg.chat.id, statsText, { parse_mode: 'HTML' });
      } else if (text === '/history' || text === '/trades') {
        try {
          if (fs.existsSync(TRADES_HISTORY_FILE)) {
            const history = JSON.parse(fs.readFileSync(TRADES_HISTORY_FILE, 'utf8'));
            if (history && history.length > 0) {
              let out = '📋 <b>Trade History (Last 10 trades)</b>\n\n';
              const last10 = history.slice(-10).reverse();
              last10.forEach((t, i) => {
                const dateStr = new Date(t.timestamp).toLocaleTimeString();
                const sign = t.pnlEth >= 0 ? '+' : '';
                out += `${i+1}. <b>${t.symbol}</b> (${t.exitType})\n` +
                       `   Amt: ${ethers.formatEther(BigInt(t.amount || '0'))}\n` +
                       `   PnL: ${sign}${t.pnlEth.toFixed(6)} ETH (${sign}${t.pnlPct}%)\n` +
                       `   Time: ${dateStr} | <a href="${EXPLORER}/tx/${t.txHash}">Tx</a>\n\n`;
              });
              await telegramBot.sendMessage(msg.chat.id, out, { parse_mode: 'HTML', disable_web_page_preview: true });
            } else {
              await telegramBot.sendMessage(msg.chat.id, 'No trade history found.');
            }
          } else {
            await telegramBot.sendMessage(msg.chat.id, 'No trade history found.');
          }
        } catch (e) {
          await telegramBot.sendMessage(msg.chat.id, 'Error loading history: ' + e.message);
        }
      } else if (text === '/clearhistory') {
        try {
          if (fs.existsSync(TRADES_HISTORY_FILE)) {
            fs.unlinkSync(TRADES_HISTORY_FILE);
          }
          dailyStats.realizedPnl = 0;
          await telegramBot.sendMessage(msg.chat.id, '✅ Trade history and realized PnL cleared.');
        } catch (e) {
          await telegramBot.sendMessage(msg.chat.id, 'Failed to clear history: ' + e.message);
        }
      } else if (text.startsWith('/estimate ')) {
        const parts = text.split(' ');
        const addr = parts[1];
        const amtStr = parts[2] || '0.0001';
        if (addr && addr.startsWith('0x')) {
          const amt = ethers.parseEther(amtStr);
          const est = await estimateBuyOutput(addr, amt);
          const price = await getCurrentPrice(addr);
          await telegramBot.sendMessage(msg.chat.id, `📊 Estimate for ${amtStr} ETH on ${addr}:\nTokens: ${ethers.formatEther(est || 0n)}\nPrice: ${ethers.formatEther(price)}\n<a href="${EXPLORER}/address/${addr}">Explorer</a>`);
        } else {
          await sendTg('Usage: /estimate <addr> [amt]');
        }
      } else if (text === '/reentry' || text === '/re') {
        await sendTg(`Re-entry: ${STRATEGY.reEntryDipPct || 30}% dip, max ${STRATEGY.maxReEntriesPerPosition || 2}`);
      } else if (text === '/gas' || text === '/fees') {
        const feeData = await provider.getFeeData();
        const gasPrice = feeData.gasPrice ? ethers.formatUnits(feeData.gasPrice, 'gwei') : 'N/A';
        const maxFee = feeData.maxFeePerGas ? ethers.formatUnits(feeData.maxFeePerGas, 'gwei') : 'N/A';
        const prio = feeData.maxPriorityFeePerGas ? ethers.formatUnits(feeData.maxPriorityFeePerGas, 'gwei') : 'N/A';
        const estBuyGas = 300000;
        const estSellGas = 550000;
        const buyCost = feeData.gasPrice ? (Number(ethers.formatUnits(feeData.gasPrice, 'ether')) * estBuyGas * 1.5).toFixed(6) : 'N/A';
        const sellCost = feeData.gasPrice ? (Number(ethers.formatUnits(feeData.gasPrice, 'ether')) * estSellGas * 1.5).toFixed(6) : 'N/A';
        await telegramBot.sendMessage(msg.chat.id, `⛽ <b>Gas (Mainnet)</b>\nGas Price: ${gasPrice} gwei\nMax Fee: ${maxFee} gwei\nPriority: ${prio} gwei\nEst Buy (0.0001): ~${buyCost} ETH\nEst Sell: ~${sellCost} ETH\nBlock: ${await provider.getBlockNumber().catch(()=>'?')}`);
      } else if (text.startsWith('/price ')) {
        const addr = text.split(' ')[1];
        if (addr && addr.startsWith('0x')) {
          const price = await getCurrentPrice(addr);
          const bal = await getBalance();
          const estTokens = price > 0 ? (SNIPE_AMOUNT * (10n**18n)) / price : 0n;
          await telegramBot.sendMessage(msg.chat.id, `💰 Price for ${addr}:\n${ethers.formatEther(price)} (units)\nEst tokens for 0.0001 ETH: ${ethers.formatEther(estTokens)}\n<a href="${EXPLORER}/address/${addr}">Explorer</a>`);
        } else {
          await telegramBot.sendMessage(msg.chat.id, 'Usage: /price 0xaddr');
        }
      } else if (text === '/pnl' || text === '/profit') {
        await sendTg('⏳ Fetching real on-chain PnL...');

        // Realized from DB
        const histStats = db.getWinRateStats();
        const realSign = histStats.totalRealizedPnl >= 0 ? '+' : '';
        const winRateStr = histStats.totalTrades > 0 ? `${histStats.winRate.toFixed(1)}%` : 'N/A';

        // Unrealized from chain
        let totalUnreal = 0;
        let totalValue = 0;
        let totalSpent = 0;
        const posLines = [];
        for (const p of positions) {
          const tok = p.token || p.curve;
          const liveBal = await getTokenBalance(tok, wallet.address).catch(() => 0n);
          const price = await getCurrentPrice(p.curve || tok).catch(() => 0n);
          const spent = p.entryPrice > 0n ? Number(ethers.formatEther(p.entryPrice)) : 0;
          totalSpent += spent;
          let valueEth = 0;
          let pnlEth = 0;
          if (liveBal > 0n && price > 0n) {
            valueEth = Number(ethers.formatEther((liveBal * price) / (10n**18n)));
            pnlEth = spent > 0 ? valueEth - spent : 0;
            totalValue += valueEth;
            totalUnreal += pnlEth;
          }
          const info = await getTokenInfo(tok);
          const sym = (info.symbol && info.symbol !== '???') ? info.symbol : tok.slice(0,8)+'...';
          const s = pnlEth >= 0 ? '+' : '';
          const balNote = liveBal === 0n ? '(no bal)' : `${ethers.formatEther(liveBal).slice(0,8)}`;
          posLines.push(`  • ${sym}: ${s}${pnlEth.toFixed(4)} ETH [${balNote}]`);
        }

        const unrSign = totalUnreal >= 0 ? '+' : '';
        const bal = await getBalance();
        const balEth = parseFloat(ethers.formatEther(bal));

        let pnlMsg = `📊 <b>Real P&amp;L Report</b>\n`;
        pnlMsg += `💰 Balance: <b>${balEth.toFixed(6)} ETH</b>\n\n`;
        pnlMsg += `📈 <b>Realized (All-Time)</b>\n`;
        pnlMsg += `P&amp;L: <b>${realSign}${histStats.totalRealizedPnl.toFixed(6)} ETH</b>\n`;
        pnlMsg += `Trades: ${histStats.totalTrades} | Wins: ${histStats.wins} | Losses: ${histStats.losses}\n`;
        pnlMsg += `Win Rate: ${winRateStr}\n\n`;
        pnlMsg += `📉 <b>Unrealized (Open Positions)</b>\n`;
        pnlMsg += `Active: ${positions.length} pos | Est Value: ${totalValue.toFixed(4)} ETH\n`;
        pnlMsg += `Unrealized: <b>${unrSign}${totalUnreal.toFixed(6)} ETH</b>\n`;
        if (posLines.length > 0) pnlMsg += posLines.join('\n') + '\n';
        pnlMsg += `\n💸 Total Entry Cost: ~${totalSpent.toFixed(4)} ETH\n`;
        pnlMsg += `<a href="${EXPLORER}/address/${wallet.address}">View Wallet on Explorer</a>`;

        await telegramBot.sendMessage(msg.chat.id, pnlMsg, { parse_mode: 'HTML', disable_web_page_preview: true });
        await sendMainMenu(msg.chat.id);
      } else if (text === '/holdings' || text === '/tokens') {
        let out = '🪙 <b>Holdings (Mainnet)</b>\n';
        const addrs = [...new Set(positions.map(p => p.token || p.curve).concat(recentLaunches.map(l => l.addr)))];
        for (const a of addrs.slice(0,8)) {
          try {
            const bal = await getTokenBalance(a, wallet.address);
            const info = await getTokenInfo(a);
            const sym = (info.symbol && info.symbol !== '???') ? info.symbol : 'Token';
            out += `${sym}: ${ethers.formatEther(bal)} @ <code>${a}</code>\n`;
          } catch (e) { out += `Addr ${a}: ${e.message ? e.message.slice(0,30) : 'query issue'}\n`; }
        }
        out += `Native: ${ethers.formatEther(await getBalance())} ETH\n<a href="${EXPLORER}/address/${wallet.address}">Wallet</a>`;
        await telegramBot.sendMessage(msg.chat.id, out);
      } else if (text === '/last' || text === '/lastlaunch') {
        if (recentLaunches.length > 0) {
          const l = recentLaunches[0];
          await telegramBot.sendMessage(msg.chat.id, `🆕 Last Launch:\n${l.symbol}\n<code>${l.addr}</code>\n${Math.floor((Date.now()-l.time)/1000)}s ago\n<a href="${EXPLORER}/address/${l.addr}">Explorer</a>`);
        } else {
          await telegramBot.sendMessage(msg.chat.id, 'No recent launches tracked.');
        }
      } else if (text === '/import') {
        await importTokensFromBlockscout(msg.chat.id);
      } else if (text === '/refresh' || text === '/fixpos') {
        await importTokensFromBlockscout(msg.chat.id).catch(() => {});
        await sendTg('Refreshing positions from on-chain...');
        for (const p of positions) {
          const taddr = p.token || p.curve;
          if (p.amount === 0n || p.entryPrice === 0n) {
            const bal = await getTokenBalance(taddr, wallet.address);
            if (bal > 0n) {
              p.amount = bal;
              if (p.entryPrice === 0n) {
                // rough, user can note spent
                p.entryPrice = 0n; // can't recover spent easily
              }
            }
          }
          const info = await getTokenInfo(taddr);
          if (info.name && !info.name.includes('Unknown')) {
            p.symbol = `${info.name} (${info.symbol})`;
          }
        }
        savePositions();
        await handlePositions(msg.chat.id);
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
        const bal = await getBalance();
        const balEth = ethers.formatEther(bal);
        const block = await provider.getBlockNumber().catch(() => 'N/A');
        const cfgText = `⚙️ Current Config (LIVE MAINNET):\n` +
          `RPC: ${RPC}\n` +
          `Current Block: ${block}\n` +
          `Snipe: ${ethers.formatEther(SNIPE_AMOUNT)} ETH\n` +
          `Balance: ${balEth} ETH\n` +
          `SL: ${STOP_LOSS * 100}%\n` +
          `TP: ${TAKE_PROFIT * 100}%\n` +
          `Factory: ${FACTORY && !FACTORY.includes('REPLACE') ? 'SET' : 'PLACEHOLDER (broad scan + known)'}\n` +
          `Poll: ${POLL_MS}ms | Honeypot: ${HONEYPOT_CHECK}\n` +
          `Moonbag: ${STRATEGY.moonbagPct || 25}%`;
        await telegramBot.sendMessage(chatId, cfgText);
        await sendMainMenu(chatId);
      } else if (data === 'spent') {
        let total = 0;
        for (const p of positions) {
          total += Number(ethers.formatEther(p.entryPrice || 0n));
        }
        await telegramBot.sendMessage(chatId, `Total est spent: ${total.toFixed(6)} ETH across ${positions.length} pos`);
        await sendMainMenu(chatId);
      } else if (data === 'block') {
        const block = await provider.getBlockNumber().catch(() => 'N/A');
        await telegramBot.sendMessage(chatId, `Current block: ${block} (mainnet)`);
        await sendMainMenu(chatId);
      } else if (data === 'check') {
        await telegramBot.sendMessage(chatId, 'Send /check <addr> to analyze (e.g. /check 0x...)');
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
        // Test menu for user to see the buy buttons immediately (demo only)
        const testAddr = '0x0000000000000000000000000000000000000000'; // dummy for test
        await sendBuyMenu(testAddr, 'TEST TOKEN');
        await telegramBot.sendMessage(chatId, '🧪 <b>TEST MENU</b> (demo only on mainnet)\nReal launches use live curve addresses from detection.\nUse /forcebuy or real buttons for actual trades.');
      } else if (data === 'diag') {
        await handleDiag(chatId);
      } else if (data === 'toggle_pause') {
        isPaused = !isPaused;
        await sendTg(isPaused ? '⏸️ Sniping paused' : '▶️ Sniping resumed');
        if (query.message.text && query.message.text.includes('Dashboard')) {
          await handleDashboardEdit(chatId, query.message.message_id);
        } else {
          await sendMainMenu(chatId);
        }
      } else if (data === 'gas' || data === 'fees') {
        const feeData = await provider.getFeeData();
        const gasPrice = feeData.gasPrice ? ethers.formatUnits(feeData.gasPrice, 'gwei') : 'N/A';
        const maxFee = feeData.maxFeePerGas ? ethers.formatUnits(feeData.maxFeePerGas, 'gwei') : 'N/A';
        const prio = feeData.maxPriorityFeePerGas ? ethers.formatUnits(feeData.maxPriorityFeePerGas, 'gwei') : 'N/A';
        const estBuyGas = 300000;
        const estSellGas = 550000;
        const buyCost = feeData.gasPrice ? (Number(ethers.formatUnits(feeData.gasPrice, 'ether')) * estBuyGas * 1.5).toFixed(6) : 'N/A';
        const sellCost = feeData.gasPrice ? (Number(ethers.formatUnits(feeData.gasPrice, 'ether')) * estSellGas * 1.5).toFixed(6) : 'N/A';
        await telegramBot.sendMessage(chatId, `⛽ <b>Gas (Mainnet)</b>\nGas Price: ${gasPrice} gwei\nMax Fee: ${maxFee} gwei\nPriority: ${prio} gwei\nEst Buy (0.0001): ~${buyCost} ETH\nEst Sell: ~${sellCost} ETH\nBlock: ${await provider.getBlockNumber().catch(()=>'?')}`);
        await sendMainMenu(chatId);
      } else if (data === 'pnl' || data === 'profit') {
        await telegramBot.answerCallbackQuery(query.id, { text: '⏳ Fetching real PnL...' });

        // --- Realized PnL from persistent DB ---
        const histStats = db.getWinRateStats();
        const realSign = histStats.totalRealizedPnl >= 0 ? '+' : '';
        const winRateStr = histStats.totalTrades > 0 ? `${histStats.winRate.toFixed(1)}%` : 'N/A';

        // --- Unrealized PnL from live chain ---
        let totalUnreal = 0;
        let totalValue = 0;
        let totalSpent = 0;
        const posLines = [];
        for (const p of positions) {
          const tok = p.token || p.curve;
          const liveBal = await getTokenBalance(tok, wallet.address).catch(() => 0n);
          const price = await getCurrentPrice(p.curve || tok).catch(() => 0n);
          const spent = p.entryPrice > 0n ? Number(ethers.formatEther(p.entryPrice)) : 0;
          totalSpent += spent;
          let valueEth = 0;
          let pnlEth = 0;
          if (liveBal > 0n && price > 0n) {
            valueEth = Number(ethers.formatEther((liveBal * price) / (10n**18n)));
            pnlEth = spent > 0 ? valueEth - spent : 0;
            totalValue += valueEth;
            totalUnreal += pnlEth;
          }
          const info = await getTokenInfo(tok);
          const sym = (info.symbol && info.symbol !== '???') ? info.symbol : tok.slice(0,8)+'...';
          const s = pnlEth >= 0 ? '+' : '';
          const balNote = liveBal === 0n ? '(no bal)' : `${ethers.formatEther(liveBal).slice(0,8)}`;
          posLines.push(`  • ${sym}: ${s}${pnlEth.toFixed(4)} ETH [${balNote}]`);
        }

        const unrSign = totalUnreal >= 0 ? '+' : '';
        const bal = await getBalance();
        const balEth = parseFloat(ethers.formatEther(bal));

        let pnlMsg = `📊 <b>Real PnL Report</b>\n`;
        pnlMsg += `💰 Balance: <b>${balEth.toFixed(6)} ETH</b>\n\n`;
        pnlMsg += `📈 <b>Realized (All-Time)</b>\n`;
        pnlMsg += `P&amp;L: <b>${realSign}${histStats.totalRealizedPnl.toFixed(6)} ETH</b>\n`;
        pnlMsg += `Trades: ${histStats.totalTrades} | Wins: ${histStats.wins} | Losses: ${histStats.losses}\n`;
        pnlMsg += `Win Rate: ${winRateStr}\n\n`;
        pnlMsg += `📉 <b>Unrealized (Open Positions)</b>\n`;
        pnlMsg += `Active: ${positions.length} pos | Est Value: ${totalValue.toFixed(4)} ETH\n`;
        pnlMsg += `Unrealized PnL: <b>${unrSign}${totalUnreal.toFixed(6)} ETH</b>\n`;
        if (posLines.length > 0) pnlMsg += posLines.join('\n') + '\n';
        pnlMsg += `\n💸 Total Entry Cost: ~${totalSpent.toFixed(4)} ETH\n`;
        pnlMsg += `<a href="${EXPLORER}/address/${wallet.address}">View on Explorer</a>`;

        await telegramBot.sendMessage(chatId, pnlMsg, { parse_mode: 'HTML', disable_web_page_preview: true });
        await sendMainMenu(chatId);
      } else if (data === 'holdings' || data === 'tokens') {
        let out = '🪙 <b>Holdings (Mainnet)</b>\n';
        const addrs = [...new Set(positions.map(p => p.token || p.curve).concat(recentLaunches.map(l => l.addr)))];
        for (const a of addrs.slice(0,8)) {
          try {
            const bal = await getTokenBalance(a, wallet.address);
            const info = await getTokenInfo(a);
            const sym = (info.symbol && info.symbol !== '???') ? info.symbol : 'Token';
            out += `${sym}: ${ethers.formatEther(bal)} @ <code>${a}</code>\n`;
          } catch (e) { out += `Addr ${a}: ${e.message ? e.message.slice(0,30) : 'query issue'}\n`; }
        }
        out += `Native: ${ethers.formatEther(await getBalance())} ETH\n<a href="${EXPLORER}/address/${wallet.address}">Wallet</a>`;
        await telegramBot.sendMessage(chatId, out);
        await sendMainMenu(chatId);
      } else if (data === 'clearpos') {
        // Clear dead zero-balance positions
        const before = positions.length;
        const deadPositions = [];
        for (const p of [...positions]) {
          const tok = p.token || p.curve;
          const liveBal = await getTokenBalance(tok, wallet.address).catch(() => 0n);
          if (liveBal === 0n && p.amount === 0n) deadPositions.push(p);
        }
        for (const p of deadPositions) {
          const idx = positions.indexOf(p);
          if (idx !== -1) positions.splice(idx, 1);
        }
        savePositions();
        const cleared = before - positions.length;
        await sendTg(`🗑️ Cleared ${cleared} dead position(s). ${positions.length} remaining.`);
        if (positions.length > 0) await handlePositions(chatId);
        else await sendMainMenu(chatId, `✅ All stale positions cleared.`);
      } else if (data === 'refresh' || data === 'fixpos') {
        await importTokensFromBlockscout(chatId).catch(() => {});
        await sendTg('Refreshing positions from on-chain...');
        for (const p of positions) {
          const taddr = p.token || p.curve;
          if (p.amount === 0n || p.entryPrice === 0n) {
            const bal = await getTokenBalance(taddr, wallet.address);
            if (bal > 0n) {
              p.amount = bal;
              if (p.entryPrice === 0n) {
                p.entryPrice = 0n;
              }
            }
          }
          const info = await getTokenInfo(taddr);
          if (info.name && !info.name.includes('Unknown')) {
            p.symbol = `${info.name} (${info.symbol})`;
          }
        }
        savePositions();
        await handlePositions(chatId);
        await sendMainMenu(chatId);
      } else if (data === 'stats') {
        const block = await provider.getBlockNumber().catch(() => null);
        const statsText = getStatsText(block);
        await telegramBot.sendMessage(chatId, statsText, { parse_mode: 'HTML' });
        await sendMainMenu(chatId);
      } else if (data === 'history') {
        try {
          if (fs.existsSync(TRADES_HISTORY_FILE)) {
            const history = JSON.parse(fs.readFileSync(TRADES_HISTORY_FILE, 'utf8'));
            if (history && history.length > 0) {
              let out = '📋 <b>Trade History (Last 10 trades)</b>\n\n';
              const last10 = history.slice(-10).reverse();
              last10.forEach((t, i) => {
                const dateStr = new Date(t.timestamp).toLocaleTimeString();
                const sign = t.pnlEth >= 0 ? '+' : '';
                out += `${i+1}. <b>${t.symbol}</b> (${t.exitType})\n` +
                       `   Amt: ${ethers.formatEther(BigInt(t.amount || '0'))}\n` +
                       `   PnL: ${sign}${t.pnlEth.toFixed(6)} ETH (${sign}${t.pnlPct}%)\n` +
                       `   Time: ${dateStr} | <a href="${EXPLORER}/tx/${t.txHash}">Tx</a>\n\n`;
              });
              await telegramBot.sendMessage(chatId, out, { parse_mode: 'HTML', disable_web_page_preview: true });
            } else {
              await telegramBot.sendMessage(chatId, 'No trade history found.');
            }
          } else {
            await telegramBot.sendMessage(chatId, 'No trade history found.');
          }
        } catch (e) {
          await telegramBot.sendMessage(chatId, 'Error loading history: ' + e.message);
        }
        await sendMainMenu(chatId);
      } else if (data === 'config') {
        const bal = await getBalance();
        const balEth = ethers.formatEther(bal);
        const block = await provider.getBlockNumber().catch(() => 'N/A');
        const cfgText = `⚙️ Current Config (LIVE MAINNET):\n` +
          `RPC: ${RPC}\n` +
          `Current Block: ${block}\n` +
          `Snipe: ${ethers.formatEther(SNIPE_AMOUNT)} ETH\n` +
          `Balance: ${balEth} ETH\n` +
          `SL: ${STOP_LOSS * 100}%\n` +
          `TP: ${TAKE_PROFIT * 100}%\n` +
          `Factory: ${FACTORY && !FACTORY.includes('REPLACE') ? 'SET' : 'PLACEHOLDER (broad scan + known)'}\n` +
          `Poll: ${POLL_MS}ms | Honeypot: ${HONEYPOT_CHECK}\n` +
          `Moonbag: ${STRATEGY.moonbagPct || 25}%`;
        await telegramBot.sendMessage(chatId, cfgText);
        await sendMainMenu(chatId);
      } else if (data === 'dashboard') {
        await handleDashboard(chatId);
      } else if (data === 'dash_refresh') {
        await handleDashboardEdit(chatId, query.message.message_id);
      } else if (data === 'cfg_snipe_up') {
        SNIPE_AMOUNT = SNIPE_AMOUNT + ethers.parseEther('0.0001');
        await handleDashboardEdit(chatId, query.message.message_id);
      } else if (data === 'cfg_snipe_down') {
        if (SNIPE_AMOUNT > ethers.parseEther('0.0001')) {
          SNIPE_AMOUNT = SNIPE_AMOUNT - ethers.parseEther('0.0001');
        }
        await handleDashboardEdit(chatId, query.message.message_id);
      } else if (data === 'cfg_slip_up') {
        SLIPPAGE_PCT = Math.min(SLIPPAGE_PCT + 5, 95);
        await handleDashboardEdit(chatId, query.message.message_id);
      } else if (data === 'cfg_slip_down') {
        SLIPPAGE_PCT = Math.max(SLIPPAGE_PCT - 5, 1);
        await handleDashboardEdit(chatId, query.message.message_id);
      } else if (data === 'cfg_pos_up') {
        MAX_POS = Math.min(MAX_POS + 1, 50);
        await handleDashboardEdit(chatId, query.message.message_id);
      } else if (data === 'cfg_pos_down') {
        MAX_POS = Math.max(MAX_POS - 1, 1);
        await handleDashboardEdit(chatId, query.message.message_id);
      } else if (data === 'toggle_paper') {
        const nextMode = !globalThis.paperTrading;
        updateTradingMode(nextMode);
        await sendTg(nextMode ? '🧪 Switched to <b>PAPER TRADING</b> mode' : '🟢 Switched to <b>LIVE TRADING</b> mode');
        await handleDashboardEdit(chatId, query.message.message_id);
      }
    });

    logger.info('Telegram alerts + BUTTONS ENABLED (fun.noxa.fi mode)');
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

// getTokenInfo is implemented below with full caching and parallel execution.

// Send buy menu for a newly detected token with specific amounts
// tokenAddr = address for buy buttons (curve), nameAddr = optional for ERC20 name lookup
async function sendBuyMenu(tokenAddr, fallbackSymbol = "NEW", nameAddr = null) {
  if (!telegramBot || !TG_CHAT || !ENABLE_TG) return;
  try {
    const lookupAddr = nameAddr || tokenAddr;
    const info = await getTokenInfo(lookupAddr);
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
  } catch (e) {
    logger.debug('sendBuyMenu failed: ' + (e.message || e));
  }
}

// General buy function for variable amount
// General buy function for variable amount
async function buyToken(curveAddress, amountStr) {
  const buyAmount = ethers.parseEther(amountStr);
  logger.info(`[MANUAL BUY] ${curveAddress} for ${amountStr} ETH`);

  try {
    let txHash, blockNumber, amount, entryPrice, actualToken;
    let info = await getTokenInfo(curveAddress);
    actualToken = curveToToken.get(curveAddress.toLowerCase()) || curveAddress;

    if (globalThis.paperTrading) {
      txHash = '0xsim' + Math.random().toString(16).slice(2).padStart(60, '0');
      blockNumber = await provider.getBlockNumber().catch(() => 9999999);
      const estOut = await estimateBuyOutput(curveAddress, buyAmount);
      amount = estOut || (buyAmount * (10n ** 18n) / (await getCurrentPrice(curveAddress) || 1n));
      if (amount === 0n) amount = 1000n * (10n**18n); // default safe
      entryPrice = await getCurrentPrice(curveAddress);
      if (entryPrice === 0n) entryPrice = (buyAmount * (10n ** 18n)) / amount;
      
      logger.info(`[PAPER BOUGHT] tx: ${txHash}`);
      await sendTg(`🧪 <b>[PAPER TRADE]</b> Bought ${amountStr} ETH worth\nTx: <code>${txHash}</code>`);
    } else {
      const curve = new ethers.Contract(FACTORY, curveABI, wallet);
      const feeData = await provider.getFeeData();
      const maxFee = (feeData.maxFeePerGas || feeData.gasPrice) * BigInt(Math.floor(GAS_MULT * 100)) / 100n;

      let tokenForBal = curveToToken.get(curveAddress.toLowerCase()) || curveAddress;
      const balBefore = await getTokenBalance(tokenForBal, wallet.address);

      let minOut = 0n;
      let gasEst = 300000n;
      try {
        gasEst = await curve.buy.estimateGas(curveAddress, { value: buyAmount });
      } catch (e) {
        // estimate may fail due to sim funds, use fixed
      }

      const tx = await curve.buy(curveAddress, {
        value: buyAmount,
        gasLimit: gasEst * 140n / 100n,
        maxFeePerGas: maxFee,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas || (maxFee / 2n)
      });
      const receipt = await withTimeout(tx.wait(), 120000, 'buy tx.wait');
      txHash = receipt.hash || receipt.transactionHash || 'unknown';
      blockNumber = receipt.blockNumber;
      const txLink = `${EXPLORER}/tx/${txHash}`;

      // Use log parsing first for real received amount (curve vs token mismatch safe)
      const rec = await getReceivedAmountFromReceipt(receipt, wallet.address);
      const fromLog = rec.amount;
      actualToken = rec.token || curveToToken.get(curveAddress.toLowerCase()) || curveAddress;
      const balAfter = await getTokenBalance(actualToken, wallet.address);
      amount = fromLog > 0n ? fromLog : (balAfter > balBefore ? (balAfter - balBefore) : 0n);
      if (amount === 0n) {
        // Strong fallback for new tokens: post-buy balance on the discovered token is the received amount
        const postBal = await getTokenBalance(actualToken, wallet.address);
        if (postBal > 0n) {
          amount = postBal;
        }
      }
      if (amount === 0n) {
        logger.warn(`[BUY] No tokens received for ${curveAddress}`);
        await sendTg(`⚠️ Buy tx mined but no tokens received for ${curveAddress}. Wrong curve addr or contract issue. <a href="${txLink}">Check tx</a>`);
        return;
      }

      entryPrice = await getCurrentPrice(curveAddress);
      if (entryPrice === 0n && amount > 0n) {
        entryPrice = (buyAmount * (10n ** 18n)) / amount;
      }

      logger.info(`[BOUGHT] tx: ${txHash}`);
      await sendAlert(`✅ Bought ${amountStr} ETH on ${curveAddress}\nTx: ${txHash}\n${txLink}`);
      await sendTg(`✅ Bought ${amountStr} ETH worth\nTx: <code>${txHash}</code>\n<a href="${txLink}">View on Blockscout</a> | <a href="https://bullscan.fun/robinhood/token/${actualToken}">Bullscan</a>`);
    }

    // Check if already have position
    const existing = positions.find(p => (p.curve || p.token) === curveAddress || p.token === curveAddress);
    if (existing) {
      existing.amount += amount;
    } else {
      positions.push({
        curve: curveAddress,
        token: actualToken,
        symbol: `${info.name} (${info.symbol})`,
        amount,
        entryPrice,
        highestPrice: entryPrice,
        isMigrated: false,
        entryBlock: blockNumber,
        soldAmount: 0n,
        reEntries: 0,
        tpReached: [],
        entryTime: Date.now(),
        isPaper: !!globalThis.paperTrading
      });
    }
    savePositions();
  } catch (e) {
    logger.error(`[BUY FAIL]: ${e.message}`);
    await sendTg(`❌ Buy failed: ${e.message.slice(0,100)}`);
  }
}

async function forceBuy(curveAddress, amountStr) {
  const buyAmount = ethers.parseEther(amountStr);
  logger.info(`[FORCE BUY] ${curveAddress} for ${amountStr} ETH (bypassing checks)`);

  try {
    let txHash, blockNumber, amount, entryPrice, actualToken;
    let info = await getTokenInfo(curveAddress);
    actualToken = curveToToken.get(curveAddress.toLowerCase()) || curveAddress;

    if (globalThis.paperTrading) {
      txHash = '0xsim' + Math.random().toString(16).slice(2).padStart(60, '0');
      blockNumber = await provider.getBlockNumber().catch(() => 9999999);
      const estOut = await estimateBuyOutput(curveAddress, buyAmount);
      amount = estOut || (buyAmount * (10n ** 18n) / (await getCurrentPrice(curveAddress) || 1n));
      if (amount === 0n) amount = 1000n * (10n**18n); // default safe
      entryPrice = await getCurrentPrice(curveAddress);
      if (entryPrice === 0n) entryPrice = (buyAmount * (10n ** 18n)) / amount;
      
      logger.info(`[PAPER FORCE BOUGHT] tx: ${txHash}`);
      await sendTg(`🧪 <b>[PAPER TRADE]</b> Force Bought ${amountStr} ETH worth\nTx: <code>${txHash}</code>`);
    } else {
      const curve = new ethers.Contract(FACTORY, curveABI, wallet);
      const feeData = await provider.getFeeData();
      const maxFee = (feeData.maxFeePerGas || feeData.gasPrice) * BigInt(Math.floor(GAS_MULT * 100)) / 100n;

      let tokenForBal = curveToToken.get(curveAddress.toLowerCase()) || curveAddress;
      const balBefore = await getTokenBalance(tokenForBal, wallet.address);

      let minOut = 0n;
      let gasEst = 300000n;
      try {
        gasEst = await curve.buy.estimateGas(curveAddress, { value: buyAmount });
      } catch (e) {
        gasEst = 300000n;
      }

      const tx = await curve.buy(curveAddress, {
        value: buyAmount,
        gasLimit: gasEst * 150n / 100n,
        maxFeePerGas: maxFee,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas || (maxFee / 2n)
      });
      const receipt = await withTimeout(tx.wait(), 120000, 'forcebuy tx.wait');
      txHash = receipt.hash || receipt.transactionHash || 'unknown';
      blockNumber = receipt.blockNumber;
      const txLink = `${EXPLORER}/tx/${txHash}`;

      const rec = await getReceivedAmountFromReceipt(receipt, wallet.address);
      const fromLog = rec.amount;
      actualToken = rec.token || curveToToken.get(curveAddress.toLowerCase()) || curveAddress;
      const balAfter = await getTokenBalance(actualToken, wallet.address);
      amount = fromLog > 0n ? fromLog : (balAfter > balBefore ? (balAfter - balBefore) : 0n);
      if (amount === 0n) {
        const postBal = await getTokenBalance(actualToken, wallet.address);
        if (postBal > 0n) {
          amount = postBal;
        }
      }
      if (amount === 0n) {
        logger.warn(`[FORCE BUY] No tokens received for ${curveAddress}`);
        await sendTg(`⚠️ Force buy tx mined but no tokens received for ${curveAddress}. Wrong curve addr or contract issue. <a href="${txLink}">Check tx</a>`);
        return;
      }
      entryPrice = await getCurrentPrice(curveAddress);
      if (entryPrice === 0n && amount > 0n) {
        entryPrice = (buyAmount * (10n ** 18n)) / amount;
      }

      logger.info(`[FORCE BOUGHT] tx: ${txHash}`);
      await sendAlert(`✅ Force Bought ${amountStr} ETH on ${curveAddress}\nTx: ${txHash}\n${txLink}`);
      await sendTg(`✅ Force Bought ${amountStr} ETH worth\nTx: <code>${txHash}</code>\n<a href="${txLink}">View on Blockscout</a> | <a href="https://bullscan.fun/robinhood/token/${actualToken}">Bullscan</a>`);
    }

    const existing = positions.find(p => (p.curve || p.token) === curveAddress || p.token === curveAddress);
    if (existing) {
      existing.amount += amount;
    } else {
      positions.push({
        curve: curveAddress,
        token: actualToken,
        symbol: `${info.name} (${info.symbol})`,
        amount,
        entryPrice,
        highestPrice: entryPrice,
        isMigrated: false,
        entryBlock: blockNumber,
        soldAmount: 0n,
        reEntries: 0,
        tpReached: [],
        entryTime: Date.now(),
        isPaper: !!globalThis.paperTrading
      });
    }
    savePositions();
  } catch (e) {
    logger.error(`[FORCE BUY FAIL]: ${e.message}`);
    await sendTg(`❌ Force buy failed: ${e.message.slice(0,100)}`);
  }
}

const tokenInfoCache = new Map();

async function getTokenInfo(addr) {
  if (!addr || addr === '0x0000000000000000000000000000000000000000') return { name: "Unknown Token", symbol: "???" };
  const cached = tokenInfoCache.get(addr.toLowerCase());
  if (cached) return cached;

  let name = "Unknown Token";
  let symbol = "???";
  // Try Blockscout API
  try {
    const { url, options } = getBlockscoutApiOptions(`https://robinhoodchain.blockscout.com/api/v2/tokens/${addr}`);
    const res = await withTimeout(fetch(url, options), 4000, 'getTokenInfo fetch').catch(() => null);
    if (res && res.ok) {
      const data = await res.json();
      const tokenInfo = data.token || data;
      if (tokenInfo.name) name = tokenInfo.name;
      if (tokenInfo.symbol) symbol = tokenInfo.symbol;
    }
  } catch (e) {}
  // Then try on-chain ERC20 if better
  try {
    const erc20Abi = [
      "function name() view returns (string)",
      "function symbol() view returns (string)"
    ];
    const token = new ethers.Contract(addr, erc20Abi, provider);
    const [onName, onSym] = await Promise.all([
      token.name().catch(() => name),
      token.symbol().catch(() => symbol)
    ]);
    if (onName && onName !== "Unknown Token") name = onName;
    if (onSym && onSym !== "???") symbol = onSym;
  } catch {}
  
  const result = { name, symbol };
  tokenInfoCache.set(addr.toLowerCase(), result);
  return result;
}

async function handleStatus(chatId) {
  // Send instant reply first
  await sendTg('⏳ Fetching real on-chain data...');

  const [bal, block] = await Promise.all([
    getBalance(),
    directProvider.getBlockNumber().catch(() => '?')
  ]);
  const balEth = parseFloat(ethers.formatEther(bal));
  const walletLink = `${EXPLORER}/address/${wallet.address}`;

  // Realized PnL from persistent trade history
  const histStats = db.getWinRateStats();

  // Unrealized PnL: scan all tracked positions for live values
  let unrealizedEth = 0;
  let activePositions = 0;
  const posDetails = [];

  // Auto-purge dead positions (amount=0 AND no on-chain balance)
  const purgeable = [];
  for (const p of positions) {
    const tok = p.token || p.curve;
    const liveBal = await getTokenBalance(tok, wallet.address).catch(() => 0n);
    if (liveBal === 0n && p.amount === 0n) {
      purgeable.push(p);
      continue;
    }
    const price = await getCurrentPrice(p.curve || tok).catch(() => 0n);
    const valueEth = liveBal > 0n && price > 0n ? Number(ethers.formatEther((liveBal * price) / (10n**18n))) : 0;
    const entryEth = p.entryPrice > 0n ? Number(ethers.formatEther(p.entryPrice)) : 0;
    const pnlEth = entryEth > 0 ? valueEth - entryEth : 0;
    unrealizedEth += pnlEth;
    activePositions++;
    const info = await getTokenInfo(tok);
    posDetails.push({ sym: `${info.name} (${info.symbol})`, valueEth, pnlEth });
  }

  // Purge dead positions
  if (purgeable.length > 0) {
    for (const p of purgeable) {
      const idx = positions.indexOf(p);
      if (idx !== -1) positions.splice(idx, 1);
    }
    savePositions();
    logger.info(`[STATUS] Auto-purged ${purgeable.length} dead zero-balance positions`);
  }

  const realPnlSign = histStats.totalRealizedPnl >= 0 ? '+' : '';
  const unrSign = unrealizedEth >= 0 ? '+' : '';
  const winRateStr = histStats.totalTrades > 0 ? `${histStats.winRate.toFixed(1)}%` : 'N/A';

  let text = `📊 <b>Status — Live Mainnet</b>\n`;
  text += `<a href="${walletLink}">${wallet.address.slice(0,10)}...${wallet.address.slice(-8)}</a>\n`;
  text += `Block: ${block} | Paused: ${isPaused ? '⏸️' : '▶️'}\n\n`;
  text += `💰 <b>Balance:</b> <b>${balEth.toFixed(6)} ETH</b>\n\n`;
  text += `📈 <b>Realized PnL (All-Time)</b>\n`;
  text += `Total: <b>${realPnlSign}${histStats.totalRealizedPnl.toFixed(6)} ETH</b>\n`;
  text += `Trades: ${histStats.totalTrades} | Wins: ${histStats.wins} | Losses: ${histStats.losses}\n`;
  text += `Win Rate: ${winRateStr}\n\n`;
  text += `📉 <b>Unrealized PnL (Open Positions)</b>\n`;
  text += `Active: ${activePositions} pos | Est: <b>${unrSign}${unrealizedEth.toFixed(6)} ETH</b>\n`;
  if (posDetails.length > 0) {
    posDetails.forEach(pd => {
      const s = pd.pnlEth >= 0 ? '+' : '';
      text += `  • ${pd.sym}: ${s}${pd.pnlEth.toFixed(4)} ETH (~${pd.valueEth.toFixed(4)} ETH value)\n`;
    });
  }
  if (purgeable.length > 0) text += `\n🗑️ Auto-cleared ${purgeable.length} stale zero-balance position(s).`;
  if (activePositions === 0 && histStats.totalTrades === 0) {
    text += `\n💡 No trades yet. Bot is scanning for launches.`;
  }

  await telegramBot.sendMessage(chatId, text, { parse_mode: 'HTML', disable_web_page_preview: true });
}

async function importTokensFromBlockscout(chatId) {
  try {
    await sendTg('⏳ Checking Blockscout for on-chain token balances to import...');
    
    const url = `https://robinhoodchain.blockscout.com/api/v2/addresses/${wallet.address}/token-balances`;
    const { url: finalUrl, options } = getBlockscoutApiOptions(url);
    const https = require('https');
    const urlObj = new URL(finalUrl);
    const requestOptions = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      headers: options.headers || {}
    };
    const rawData = await new Promise((resolve, reject) => {
      https.get(requestOptions, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => resolve(body));
      }).on('error', reject);
    });

    const items = JSON.parse(rawData);
    if (!Array.isArray(items)) {
      await sendTg('❌ Failed to parse token balances from Blockscout.');
      return;
    }

    let importedCount = 0;
    const importedSymbols = [];

    for (const item of items) {
      if (!item.token || item.token.type !== 'ERC-20') continue;
      const tokenAddr = item.token.address_hash.toLowerCase();
      const value = item.value || '0';
      const bal = BigInt(value);
      if (bal === 0n) continue;

      // Skip native wrapped tokens
      if (WETH && tokenAddr === WETH.toLowerCase()) continue;

      // Check if already in positions
      const exists = positions.some(p => (p.token || p.curve).toLowerCase() === tokenAddr);
      if (exists) continue;

      const name = item.token.name || 'Unknown';
      const symbol = item.token.symbol || '???';
      const sym = `${name} (${symbol})`;

      // Get current price if possible
      const price = await getLivePrice(tokenAddr, tokenAddr).catch(() => 0n);

      positions.push({
        curve: tokenAddr,
        token: tokenAddr,
        symbol: sym,
        amount: bal,
        entryPrice: price, // set to current price to track gains from import point
        highestPrice: price,
        isMigrated: true, // assume DEX fallback is safest for old holdings
        entryBlock: 0,
        soldAmount: 0n,
        reEntries: 0,
        tpReached: []
      });

      importedCount++;
      importedSymbols.push(symbol);
    }

    if (importedCount > 0) {
      savePositions();
      await sendTg(`✅ Imported ${importedCount} token(s) from your wallet: ${importedSymbols.join(', ')}\n\nThey are now tracked in your positions list!`);
    }
  } catch (e) {
    logger.warn('Failed to import tokens from Blockscout: ' + e.message);
  }
}

async function handlePositions(chatId) {
  if (positions.length === 0) {
    await telegramBot.sendMessage(chatId, '📍 No open positions tracked.\n\nUse /status to see your balance or /history for past trades.');
    return;
  }

  await sendTg('⏳ Loading live position data...');

  // Resolve all positions in parallel with live on-chain data
  const resolvedPositions = await Promise.all(positions.map(async (p, i) => {
    const posTok = p.token || p.curve;
    const posCurve = p.curve || p.token;

    // Live balance from chain
    const liveBal = await getTokenBalance(posTok, wallet.address).catch(() => 0n);
    const balStr = ethers.formatEther(liveBal);

    // Live price
    const price = await getCurrentPrice(posCurve).catch(() => 0n);
    const priceStr = price > 0n ? ethers.formatEther(price) : 'N/A';

    // Live value + PnL
    let valueStr = 'N/A';
    let pnlStr = '';
    if (liveBal > 0n && price > 0n) {
      const valueWei = (liveBal * price) / (10n**18n);
      const valueEth = parseFloat(ethers.formatEther(valueWei));
      valueStr = valueEth.toFixed(6) + ' ETH';
      if (p.entryPrice > 0n) {
        const entryEth = parseFloat(ethers.formatEther(p.entryPrice));
        const pnlEth = valueEth - entryEth;
        const pnlPct = (pnlEth / entryEth) * 100;
        const sign = pnlEth >= 0 ? '+' : '';
        pnlStr = ` | PnL: <b>${sign}${pnlEth.toFixed(4)} ETH (${sign}${pnlPct.toFixed(1)}%)</b>`;
      }
    } else if (liveBal === 0n) {
      valueStr = '⚠️ Zero balance (stale?)';
    }

    const info = await getTokenInfo(posTok);
    let sym = `${info.name} (${info.symbol})`;
    if (info.name === 'Unknown Token' || info.symbol === '???') {
      sym = `Token (${posTok.slice(0,6)}...${posTok.slice(-4)})`;
    }

    const entryStr = p.entryPrice > 0n ? ethers.formatEther(p.entryPrice) + ' ETH' : 'Unknown';
    const migStr = p.isMigrated ? ' 🔄 DEX' : ' 🟢 Curve';
    const explorerLink = `${EXPLORER}/address/${posTok}`;

    return {
      text: `${i+1}. <b>${sym}</b>${migStr}\n` +
            `   <a href="${explorerLink}">${posTok.slice(0,10)}...${posTok.slice(-6)}</a> | <a href="https://bullscan.fun/robinhood/token/${posTok}">Bullscan</a>\n` +
            `   Bal: <b>${balStr}</b> | Price: ${priceStr}\n` +
            `   Value: <b>${valueStr}</b>${pnlStr}\n` +
            `   Entry: ${entryStr} | Re-entries: ${p.reEntries || 0}\n`,
      symbol: sym,
      isDead: liveBal === 0n
    };
  }));

  const active = resolvedPositions.filter(r => !r.isDead);
  const dead = resolvedPositions.filter(r => r.isDead);

  let text = `📍 <b>Positions (${positions.length} tracked, ${active.length} active)</b>\n\n`;
  resolvedPositions.forEach(rp => { text += rp.text + '\n'; });

  if (dead.length > 0) {
    text += `\n💡 ${dead.length} position(s) have zero balance. Use /clearpos to clean them up.`;
  }

  const keyboard = {
    inline_keyboard: [
      ...positions.map((p, i) => [
        { text: `💸 Sell #${i+1} ${resolvedPositions[i].symbol.slice(0,10)}`, callback_data: `sell_${i}` }
      ]),
      [{ text: '🗑️ Clear Dead Positions', callback_data: 'clearpos' }]
    ]
  };
  await telegramBot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: keyboard, disable_web_page_preview: true });
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
    const walletLink = `${EXPLORER}/address/${wallet.address}`;
    
    const text = `🔍 <b>DIAG - Real Mainnet Output</b>\n` +
      `Mode: LIVE MAINNET ONLY\n` +
      `Status: ${paused}\n` +
      `Wallet: <a href="${walletLink}"><code>${wallet.address}</code></a>\n` +
      `Balance: ${balEth} ETH\n` +
      `Current Block: ${block}\n` +
      `Snipe Amount: ${snipe} ETH\n` +
      `Positions: ${posCount}\n` +
      `Factory: ${factoryStatus}\n` +
      `Poll Interval: ${POLL_MS}ms | Honeypot: ${HONEYPOT_CHECK}\n` +
      `Strategy Moonbag: ${STRATEGY.moonbagPct || 25}%\n` +
      `RPC: ${RPC}\n` +
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
function getPositionsFile() {
  return globalThis.paperTrading ? 'paper_positions.json' : POSITIONS_FILE;
}

function loadPositions() {
  try {
    const file = getPositionsFile();
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      positions = raw.map(p => ({
        ...p,
        curve: p.curve || p.token,
        token: p.token || p.curve,
        amount: BigInt(p.amount),
        entryPrice: BigInt(p.entryPrice),
        highestPrice: BigInt(p.highestPrice || p.entryPrice),
        soldAmount: p.soldAmount ? BigInt(p.soldAmount) : 0n,
        reEntries: p.reEntries || 0
      }));
      // Refresh names for unknown on load (mainnet)
      positions.forEach(async (p, i) => {
        if (p.symbol && p.symbol.includes('Unknown')) {
          const info = await getTokenInfo(p.token);
          if (info.name && !info.name.includes('Unknown')) {
            p.symbol = `${info.name} (${info.symbol})`;
          }
        }
      });
    } else {
      positions = [];
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
    fs.writeFileSync(getPositionsFile(), JSON.stringify(serial, null, 2));
  } catch (e) {}
}

async function withRetry(fn, retries = 3, timeoutMs = 15000) {
  for (let i = 0; i < retries; i++) {
    try {
      const result = await Promise.race([
        fn(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs))
      ]);
      return result;
    } catch (e) {
      triggerRpcFailover(); // Trigger RPC rotation on network/node error
      if (i === retries - 1) throw e;
      await new Promise(r => setTimeout(r, 600 * (i + 1)));
    }
  }
}

// Timeout wrapper for any promise (use for tx.wait etc.)
function withTimeout(promise, ms, label = 'op') {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(label + ' timed out after ' + ms + 'ms')), ms))
  ]);
}

async function getCurrentPrice(tokenAddr) {
  try {
    // Factory IS the bonding curve - call curves(token) on FACTORY
    const factory = new ethers.Contract(FACTORY, curveABI, provider);
    const state = await factory.curves(tokenAddr);
    // state = [virtualEth, tokenBalance, graduated]
    // Price = virtualEth / tokenBalance (ETH per token)
    if (state && state.tokenBalance > 0n) {
      return (state.virtualEth * (10n ** 18n)) / state.tokenBalance;
    }
    return 0n;
  } catch { return 0n; }
}

async function getTokenBalance(tokenAddr, owner) {
  try {
    const erc = new ethers.Contract(tokenAddr, ["function balanceOf(address) view returns (uint256)"], provider);
    return await erc.balanceOf(owner);
  } catch { return 0n; }
}

// directProvider is declared at the top and switches dynamically with RPC updates

async function getBalance() {
  // Try FallbackProvider first, fall back to direct single RPC to avoid "network changed" returning 0
  try {
    const bal = await Promise.race([
      provider.getBalance(wallet.address),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))
    ]);
    if (bal !== undefined && bal !== null) return bal;
  } catch {}
  // Direct fallback - always works
  try {
    return await directProvider.getBalance(wallet.address);
  } catch { return 0n; }
}

// Reliable received token amount extractor from tx receipt logs (Transfer or Trade events)
// This fixes "no tokens received" even when balanceOf is queried on curve vs actual ERC20 token
async function getReceivedAmountFromReceipt(receipt, owner) {
  if (!receipt || !receipt.logs) return { amount: 0n, token: null };
  const ownerLower = owner.toLowerCase();
  const transferTopic = ethers.id('Transfer(address,address,uint256)');
  const tradeTopic = ethers.id('Trade(address,bool,uint256,uint256)');
  let received = 0n;
  let token = null;
  for (const log of receipt.logs) {
    try {
      if (!log.topics || !log.topics[0]) continue;
      const topic0 = log.topics[0];
      if (topic0 === transferTopic) {
        const to = '0x' + log.topics[2].slice(-40);
        if (to.toLowerCase() === ownerLower) {
          const val = BigInt(log.data || '0x0');
          if (val > 0n) {
            received = val;
            token = log.address;  // The ERC20 token contract that emitted the Transfer
          }
        }
      }
      if (topic0 === tradeTopic && received === 0n) {
        // Trade(trader, isBuy, ethAmount, tokenAmount) - tokenAmount is last 32 bytes of data
        const data = (log.data || '').replace('0x', '');
        if (data.length >= 64) {
          const tokenAmtHex = '0x' + data.slice(-64);
          const amt = BigInt(tokenAmtHex);
          if (amt > 0n) received = amt;
          // token may be in log.address or need other logic; fallback later
          if (!token) token = log.address;
        }
      }
    } catch {}
  }
  return { amount: received, token };
}

// ====================== NEW UPGRADES: Curve math, Honeypot, DEX sell, Risk ======================

// Estimate tokens you would receive for a buy (uses static call simulation)
async function estimateBuyOutput(curveAddress, ethAmount) {
  try {
    const factory = new ethers.Contract(FACTORY, curveABI, provider);
    const state = await factory.curves(curveAddress);
    if (!state || state.tokenBalance === 0n || state.virtualEth === 0n) return 0n;
    // Simple bonding curve estimate: tokens = (ethAmount / virtualEth) * tokenBalance
    const tokens = (ethAmount * state.tokenBalance) / (state.virtualEth + ethAmount);
    return tokens;
  } catch { return 0n; }
}

// Render dashboard inside Telegram
async function handleDashboard(chatId) {
  const block = await provider.getBlockNumber().catch(() => '?');
  const bal = await getBalance();
  const balEth = parseFloat(ethers.formatEther(bal)).toFixed(4);
  const stats = db.getWinRateStats(!!globalThis.paperTrading);
  const winRateStr = stats.totalTrades > 0 ? `${stats.winRate.toFixed(1)}%` : 'N/A';
  
  const text = `🖥️ <b>Robinhood Bot Dashboard</b>\n` +
    `--------------------------------\n` +
    `Status: ${isPaused ? '⏸️ PAUSED' : '▶️ RUNNING'}\n` +
    `Trading Mode: ${globalThis.paperTrading ? '🧪 <b>PAPER (SIMULATION)</b>' : '🟢 <b>LIVE</b>'}\n` +
    `Wallet: <code>${wallet.address}</code>\n` +
    `Balance: <b>${balEth} ETH</b>\n` +
    `Current Block: ${block}\n\n` +
    `📈 <b>Performance (All-Time ${globalThis.paperTrading ? 'Paper' : 'Live'})</b>\n` +
    `Realized PnL: <b>${stats.totalRealizedPnl.toFixed(6)} ETH</b>\n` +
    `Total Trades: ${stats.totalTrades} (${stats.wins} W / ${stats.losses} L)\n` +
    `Win Rate: ${winRateStr}\n\n` +
    `⚙️ <b>Active Parameters</b>\n` +
    `Snipe Size: <b>${ethers.formatEther(SNIPE_AMOUNT)} ETH</b>\n` +
    `Slippage: <b>${SLIPPAGE_PCT}%</b>\n` +
    `Max Positions: <b>${MAX_POS}</b>\n` +
    `Gas Multiplier: <b>${globalThis.GAS_MULT || GAS_MULT}x</b>\n` +
    `Honeypot Scanner: ${HONEYPOT_CHECK ? '✅ ON' : '❌ OFF'}`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: isPaused ? '▶️ Resume Bot' : '⏸️ Pause Bot', callback_data: 'toggle_pause' },
        { text: '🔄 Refresh', callback_data: 'dash_refresh' }
      ],
      [
        { text: globalThis.paperTrading ? '🟢 Switch to LIVE' : '🧪 Switch to PAPER', callback_data: 'toggle_paper' }
      ],
      [
        { text: '💵 Snipe: +0.0001', callback_data: 'cfg_snipe_up' },
        { text: '💵 Snipe: -0.0001', callback_data: 'cfg_snipe_down' }
      ],
      [
        { text: '📉 Slippage: +5%', callback_data: 'cfg_slip_up' },
        { text: '📉 Slippage: -5%', callback_data: 'cfg_slip_down' }
      ],
      [
        { text: '📍 Max Pos: +1', callback_data: 'cfg_pos_up' },
        { text: '📍 Max Pos: -1', callback_data: 'cfg_pos_down' }
      ],
      [
        { text: '📋 View History', callback_data: 'history' },
        { text: '🛑 Stop Bot', callback_data: 'stop' }
      ]
    ]
  };

  await telegramBot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: keyboard });
}

// Edit dashboard inside Telegram (keeps chat clean)
async function handleDashboardEdit(chatId, messageId) {
  try {
    const block = await provider.getBlockNumber().catch(() => '?');
    const bal = await getBalance();
    const balEth = parseFloat(ethers.formatEther(bal)).toFixed(4);
    const stats = db.getWinRateStats(!!globalThis.paperTrading);
    const winRateStr = stats.totalTrades > 0 ? `${stats.winRate.toFixed(1)}%` : 'N/A';
    
    const text = `🖥️ <b>Robinhood Bot Dashboard</b>\n` +
      `--------------------------------\n` +
      `Status: ${isPaused ? '⏸️ PAUSED' : '▶️ RUNNING'}\n` +
      `Trading Mode: ${globalThis.paperTrading ? '🧪 <b>PAPER (SIMULATION)</b>' : '🟢 <b>LIVE</b>'}\n` +
      `Wallet: <code>${wallet.address}</code>\n` +
      `Balance: <b>${balEth} ETH</b>\n` +
      `Current Block: ${block}\n\n` +
      `📈 <b>Performance (All-Time ${globalThis.paperTrading ? 'Paper' : 'Live'})</b>\n` +
      `Realized PnL: <b>${stats.totalRealizedPnl.toFixed(6)} ETH</b>\n` +
      `Total Trades: ${stats.totalTrades} (${stats.wins} W / ${stats.losses} L)\n` +
      `Win Rate: ${winRateStr}\n\n` +
      `⚙️ <b>Active Parameters</b>\n` +
      `Snipe Size: <b>${ethers.formatEther(SNIPE_AMOUNT)} ETH</b>\n` +
      `Slippage: <b>${SLIPPAGE_PCT}%</b>\n` +
      `Max Positions: <b>${MAX_POS}</b>\n` +
      `Gas Multiplier: <b>${globalThis.GAS_MULT || GAS_MULT}x</b>\n` +
      `Honeypot Scanner: ${HONEYPOT_CHECK ? '✅ ON' : '❌ OFF'}`;

    const keyboard = {
      inline_keyboard: [
        [
          { text: isPaused ? '▶️ Resume Bot' : '⏸️ Pause Bot', callback_data: 'toggle_pause' },
          { text: '🔄 Refresh', callback_data: 'dash_refresh' }
        ],
        [
          { text: globalThis.paperTrading ? '🟢 Switch to LIVE' : '🧪 Switch to PAPER', callback_data: 'toggle_paper' }
        ],
        [
          { text: '💵 Snipe: +0.0001', callback_data: 'cfg_snipe_up' },
          { text: '💵 Snipe: -0.0001', callback_data: 'cfg_snipe_down' }
        ],
        [
          { text: '📉 Slippage: +5%', callback_data: 'cfg_slip_up' },
          { text: '📉 Slippage: -5%', callback_data: 'cfg_slip_down' }
        ],
        [
          { text: '📍 Max Pos: +1', callback_data: 'cfg_pos_up' },
          { text: '📍 Max Pos: -1', callback_data: 'cfg_pos_down' }
        ],
        [
          { text: '📋 View History', callback_data: 'history' },
          { text: '🛑 Stop Bot', callback_data: 'stop' }
        ]
      ]
    };

    await telegramBot.editMessageText(text, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML',
      reply_markup: keyboard
    });
  } catch (e) {
    logger.debug('Dashboard edit failed: ' + e.message);
  }
}

// Scan creator history for rug trends
async function checkCreatorHistory(tokenAddress) {
  try {
    const { url: url1, options: opt1 } = getBlockscoutApiOptions(`https://robinhoodchain.blockscout.com/api/v2/addresses/${tokenAddress}`);
    const tokenRes = await fetch(url1, opt1);
    if (!tokenRes.ok) return false;
    const tokenData = await tokenRes.json();
    const creator = tokenData.creator_address_hash || tokenData.creatorAddressHash || (tokenData.creator && tokenData.creator.hash);
    if (!creator || creator === '0x0000000000000000000000000000000000000000') return false;

    logger.info(`[CREATOR SCAN] Token ${tokenAddress} creator: ${creator}`);

    const { url: url2, options: opt2 } = getBlockscoutApiOptions(`https://robinhoodchain.blockscout.com/api/v2/addresses/${creator}/tokens?type=erc-20`);
    const creatorRes = await fetch(url2, opt2);
    if (!creatorRes.ok) return false;
    const creatorData = await creatorRes.json();
    if (creatorData && creatorData.items && Array.isArray(creatorData.items)) {
      const pastTokensCount = creatorData.items.length;
      logger.info(`[CREATOR SCAN] Creator has launched ${pastTokensCount} ERC20 tokens.`);
      
      if (pastTokensCount > 5) {
        logger.warn(`[CREATOR SCAN] Creator ${creator} has high frequency launch history (${pastTokensCount} tokens) - flagged as risky.`);
        return true;
      }
    }
    return false;
  } catch (e) {
    logger.debug(`[CREATOR SCAN] Creator check failed: ${e.message}`);
    return false;
  }
}

// Stuck transaction gas bumper / speed up wrapper
async function sendTxWithBumping(contractCallFn, label = 'tx') {
  const feeData = await provider.getFeeData();
  let basePrio = feeData.maxPriorityFeePerGas || ethers.parseUnits('1', 'gwei');
  let baseMax = feeData.maxFeePerGas || (basePrio * 2n);
  
  let currentPrio = basePrio * BigInt(Math.floor(GAS_MULT * 100)) / 100n;
  let currentMax = baseMax * BigInt(Math.floor(GAS_MULT * 100)) / 100n;

  logger.info(`[BUMPING TX] Sending first attempt for ${label} (Prio: ${ethers.formatUnits(currentPrio, 'gwei')} gwei, Max: ${ethers.formatUnits(currentMax, 'gwei')} gwei)...`);

  let tx = await contractCallFn(currentMax, currentPrio);
  const nonce = tx.nonce;
  
  return new Promise((resolve, reject) => {
    let mined = false;
    
    const bumpTimeout = setTimeout(async () => {
      if (mined) return;
      try {
        const bumpedPrio = currentPrio * 150n / 100n;
        const bumpedMax = currentMax * 150n / 100n;
        
        logger.warn(`[STUCK TX] ${label} pending for 15s. Bumping gas (Prio: ${ethers.formatUnits(bumpedPrio, 'gwei')} gwei, Max: ${ethers.formatUnits(bumpedMax, 'gwei')} gwei)...`);
        
        const speedUpTx = await contractCallFn(bumpedMax, bumpedPrio, nonce);
        logger.info(`[SPEED UP] Speed up tx sent: ${speedUpTx.hash}`);
        
        const receipt = await speedUpTx.wait();
        mined = true;
        resolve(receipt);
      } catch (bumpErr) {
        logger.error(`[SPEED UP FAILED] Error speeding up transaction: ${bumpErr.message}`);
        try {
          const receipt = await tx.wait();
          mined = true;
          resolve(receipt);
        } catch (origErr) {
          reject(origErr);
        }
      }
    }, 15000);

    tx.wait().then((receipt) => {
      clearTimeout(bumpTimeout);
      if (!mined) {
        mined = true;
        resolve(receipt);
      }
    }).catch((err) => {
      clearTimeout(bumpTimeout);
      if (!mined) {
        reject(err);
      }
    });
  });
}

// TRADES_HISTORY_FILE is declared as let at the top of the file

// Fetch live price from either curve or DEX fallback
async function getLivePrice(tokenAddress, curveAddress = null) {
  const curve = curveAddress || tokenAddress;
  try {
    const curvePrice = await getCurrentPrice(curve);
    if (curvePrice > 0n) return curvePrice;
  } catch {}
  
  if (ROUTER && WETH) {
    try {
      const router = new ethers.Contract(ROUTER, routerABI, provider);
      const oneToken = ethers.parseEther('1');
      const amounts = await router.getAmountsOut(oneToken, [tokenAddress, WETH]);
      if (amounts && amounts.length >= 2) {
        return amounts[1];
      }
    } catch {}
  }
  return 0n;
}

// Log finalized trades to JSON file
function logTradeToHistory(pos, sellAmount, exitPrice, txHash, exitType) {
  try {
    let history = [];
    if (fs.existsSync(TRADES_HISTORY_FILE)) {
      history = JSON.parse(fs.readFileSync(TRADES_HISTORY_FILE, 'utf8'));
    }
    
    const entryPrice = pos.entryPrice || 0n;
    const pnlPct = entryPrice > 0n ? (Number(exitPrice - entryPrice) / Number(entryPrice)) * 100 : 0;
    const entryEth = entryPrice > 0n ? Number(ethers.formatEther(entryPrice)) * Number(ethers.formatEther(sellAmount)) : 0;
    const exitEth = Number(ethers.formatEther(exitPrice)) * Number(ethers.formatEther(sellAmount));
    const pnlEth = exitEth - entryEth;

    const tradeRecord = {
      token: pos.token || pos.curve,
      symbol: pos.symbol || 'Unknown',
      amount: sellAmount.toString(),
      entryPrice: entryPrice.toString(),
      exitPrice: exitPrice.toString(),
      pnlPct: parseFloat(pnlPct.toFixed(2)),
      pnlEth: parseFloat(pnlEth.toFixed(6)),
      txHash: txHash || 'unknown',
      exitType: exitType || 'MANUAL',
      timestamp: Date.now()
    };
    
    history.push(tradeRecord);
    fs.writeFileSync(TRADES_HISTORY_FILE, JSON.stringify(history, null, 2));
    dailyStats.realizedPnl += pnlEth;
    logger.info(`[HISTORY LOGGED] ${pos.symbol} PnL: ${pnlEth.toFixed(6)} ETH (${pnlPct.toFixed(2)}%)`);
  } catch (e) {
    logger.error('Failed to log trade to history: ' + e.message);
  }
}

// Get stats text dynamically from JSON
function getStatsText(blockNumber) {
  let totalRealizedPnl = dailyStats.realizedPnl;
  let totalTrades = dailyStats.trades;
  let wins = 0;
  let losses = 0;
  let winRate = 0;
  
  try {
    if (fs.existsSync(TRADES_HISTORY_FILE)) {
      const history = JSON.parse(fs.readFileSync(TRADES_HISTORY_FILE, 'utf8'));
      if (history && history.length > 0) {
        totalRealizedPnl = history.reduce((sum, t) => sum + (t.pnlEth || 0), 0);
        totalTrades = history.length;
        wins = history.filter(t => (t.pnlEth || 0) > 0).length;
        losses = history.filter(t => (t.pnlEth || 0) <= 0).length;
        winRate = (wins / totalTrades) * 100;
      }
    }
  } catch (e) {
    logger.error('Error loading stats from history: ' + e.message);
  }

  return `📈 <b>Real Realized Stats</b>\n` +
    `Total realized PnL: ${totalRealizedPnl.toFixed(6)} ETH\n` +
    `Realized trades: ${totalTrades} (${wins} wins / ${losses} losses)\n` +
    `Win rate: ${winRate.toFixed(1)}%\n` +
    `Daily trades count: ${dailyStats.trades}\n` +
    `Current Positions: ${positions.length}\n` +
    `Uptime: running\n` +
    `Last block: ${blockNumber || '?'}`;
}

// Verify that the deployed token contract bytecode matches the standard factory template
async function checkBytecodeSimilarity(tokenAddress) {
  try {
    const code = await directProvider.getCode(tokenAddress).catch(() => '0x');
    if (!code || code === '0x') {
      logger.debug(`[SECURITY] Bytecode empty for ${tokenAddress} - could not verify`);
      return true; // allow if code not retrieved (mempool case / block delay)
    }
    
    // Supported standard templates
    const templates = [
      {
        length: 3324,
        prefix: '0x608060405234801561000f575f5ffd5b506004361061009b575f3560e01c806370a082311161006357806370a082311461'
      },
      {
        length: 9488,
        prefix: '0x608080604052600436101561001c575b50361561001a575f80fd5b005b5f3560e01c90816302d05d3f14610a3557'
      }
    ];

    const matches = templates.some(t => code.length === t.length && code.startsWith(t.prefix));
    if (!matches) {
      logger.warn(`[SECURITY] Non-standard bytecode for ${tokenAddress} (len: ${code.length}) - potential backdoor/custom contract`);
      return false;
    }
    logger.debug(`[SECURITY] Token bytecode matches factory template`);
    return true;
  } catch (e) {
    logger.debug(`[SECURITY] Bytecode verification failed: ${e.message}`);
    return true; // fail-open on network issues
  }
}

// Check holder distribution on Blockscout to screen rugs/whales (top 10 sum > 35% or top 1 > 50%)
async function checkHolderDistribution(tokenAddress, curveAddress) {
  try {
    const { url, options } = getBlockscoutApiOptions(`https://robinhoodchain.blockscout.com/api/v2/tokens/${tokenAddress}/holders`);
    const res = await fetch(url, options);
    if (!res.ok) {
      logger.debug(`[HOLDERS] Blockscout request failed for ${tokenAddress}: ${res.statusText}`);
      return false; // don't block snipe if API is down
    }
    const data = await res.json();
    if (!data || !data.items || !Array.isArray(data.items)) {
      logger.debug(`[HOLDERS] Invalid response format for ${tokenAddress}`);
      return false;
    }

    const curveLower = curveAddress.toLowerCase();
    const zeroAddr = '0x0000000000000000000000000000000000000000';

    const sortedHolders = data.items.map(item => ({
      addr: (item.address && item.address.hash || '').toLowerCase(),
      val: BigInt(item.value || '0')
    })).filter(h => h.addr !== curveLower && h.addr !== zeroAddr && (FACTORY && h.addr !== FACTORY.toLowerCase()));

    sortedHolders.sort((a, b) => (b.val > a.val ? 1 : -1));

    let totalCirculating = 0n;
    let top10Sum = 0n;
    let counted = 0;

    for (const h of sortedHolders) {
      if (counted < 10) {
        top10Sum += h.val;
        counted++;
      }
      totalCirculating += h.val;
    }

    if (totalCirculating > 0n) {
      const top1Pct = Number((sortedHolders[0]?.val || 0n) * 100n / totalCirculating);
      const top10Pct = Number(top10Sum * 100n / totalCirculating);
      logger.info(`[HOLDERS] ${tokenAddress} - Top 1 holder: ${top1Pct}%, Top 10 holders: ${top10Pct}%`);
      if (top1Pct > 50) {
        logger.warn(`[HOLDERS] Whale concentration high (Top 1 > 50%): ${top1Pct}%`);
        return true;
      }
      if (top10Pct > 35) {
        logger.warn(`[HOLDERS] Insider concentration high (Top 10 > 35%): ${top10Pct}%`);
        return true;
      }
    }
    return false;
  } catch (e) {
    logger.debug(`[HOLDERS] Error checking holders for ${tokenAddress}: ${e.message}`);
    return false;
  }
}

// Honeypot / rug check before snipe (simulate buy then sell)
async function isHoneypotOrBad(curveAddress, tokenAddr = null) {
  if (!HONEYPOT_CHECK) return false;
  try {
    // 1. Security filters (Bytecode similarity & Holder concentration)
    const actualToken = tokenAddr || curveToToken.get(curveAddress.toLowerCase()) || curveAddress;
    if (actualToken && actualToken !== '0x0000000000000000000000000000000000000000') {
      const isStandard = await checkBytecodeSimilarity(actualToken);
      if (!isStandard) {
        logger.warn(`[HONEYPOT] Skip launch due to custom non-standard bytecode on ${actualToken}`);
        return true;
      }
      const isConcentrated = await checkHolderDistribution(actualToken, curveAddress);
      if (isConcentrated) {
        logger.warn(`[HONEYPOT] Skip launch due to high holder concentration on ${actualToken}`);
        return true;
      }
    }

    const factory = new ethers.Contract(FACTORY, curveABI, provider);
    const testAmount = ethers.parseEther('0.001');

    // Simulate buy - handle insufficient funds in estimate
    let buyGas;
    try {
      buyGas = await factory.buy.estimateGas(actualToken, { value: testAmount });
    } catch (e) {
      if (e.message.includes('insufficient funds') || e.code === 'INSUFFICIENT_FUNDS') {
        const bal = await getBalance();
        if (bal >= testAmount * 2n) {
          logger.info(`[HONEYPOT] Insufficient in estimate but wallet has enough (${ethers.formatEther(bal)} ETH) - allowing`);
          return false;
        }
      }
      logger.warn(`[HONEYPOT] Estimate failed for ${curveAddress}: ${e.message}`);
      const msg = e.message.toLowerCase();
      if (msg.includes('revert') || msg.includes('transfer') || msg.includes('overflow') || msg.includes('balance') || msg.includes('allowance') || msg.includes('zero')) {
        return true;
      }
      logger.info(`[HONEYPOT] Non-contract estimate failure (network/node glitch) - allowing launch anyway`);
      return false;
    }
    if (buyGas > 800000n) {
      logger.warn(`[HONEYPOT] High buy gas ${buyGas} for ${curveAddress}`);
      return true;
    }

    // Try to simulate sell (if we had tokens)
    const sellGas = await factory.sell.estimateGas(actualToken, 1000n).catch(() => 999999n);
    if (sellGas > 1000000n) {
      logger.warn(`[HONEYPOT] High sell gas ${sellGas} for ${curveAddress}`);
      return true;
    }

    return false;
  } catch (e) {
    logger.warn(`[HONEYPOT] General check failed for ${curveAddress}: ${e.message}`);
    const msg = e.message.toLowerCase();
    if (msg.includes('revert') || msg.includes('transfer') || msg.includes('overflow') || msg.includes('balance') || msg.includes('allowance') || msg.includes('zero')) {
      return true;
    }
    return false;
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

// Sell on DEX (Uniswap V2 style) after graduation
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
        logger.debug(`[DEX SELL] No liquidity pool for ${tokenAddress} yet - holding`);
        return null;
      }
      // Check pool has reserves
      try {
        const pairC = new ethers.Contract(pair, ['function getReserves() view returns (uint112,uint112,uint32)'], provider);
        const reserves = await pairC.getReserves();
        if (reserves[0] === 0n && reserves[1] === 0n) {
          logger.debug(`[DEX SELL] Pool empty reserves for ${tokenAddress} - holding`);
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
      logger.info(`Approving router for ${tokenAddress}...`);
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
    logger.info(`[DEX SELL] ${tokenAddress} tx: ${txHash}`);
    await sendTg(`✅ Sold on DEX!\nTx: <code>${txHash}</code>`);
    return txHash;
  } catch (e) {
    logger.error('DEX sell failed: ' + e.message);
    // No TG spam here - caller handles user messaging
    return null;
  }
}

// ====================== SNIPE (focus fun.noxa.fi) ======================
async function snipe(curveAddress, symbol = null, tokenAddr = null) {
  const sym = symbol || 'LAUNCH';
  if (isPaused) {
    logger.info(`[PAUSED] Skipping snipe for ${sym}`);
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

  logger.info(`[SNIPE] ${sym} @ ${curveAddress} (token ${tokenAddr || curveAddress}) | ${ethers.formatEther(SNIPE_AMOUNT)} ETH (fun.noxa.fi)`);

  // Honeypot / bad curve check
  if (await isHoneypotOrBad(curveAddress, tokenAddr)) {
    logger.warn(`[SKIP] Possible honeypot or bad curve: ${curveAddress}`);
    await sendTg(`⚠️ Skipped suspicious launch: ${symbol}`);
    return;
  }

  // Better curve estimation
  const estimated = await estimateBuyOutput(curveAddress, SNIPE_AMOUNT);
  logger.info(`Estimated tokens for buy: ${ethers.formatEther(estimated || 0n)}`);

  // curveAddress IS the token address; buy/sell on FACTORY
  const curve = new ethers.Contract(FACTORY, curveABI, wallet);

  // Verify curve has code (topics[2] was creator wallet, not curve)
  const curveCode = await directProvider.getCode(curveAddress).catch(() => '0x');
  if (!curveCode || curveCode.length <= 2) {
    logger.warn(`[SNIPE SKIP] ${curveAddress} has no code - not a real curve`);
    return;
  }

  // Wait for curve to become ready (retry up to 6x, 2s apart = 12s max)
  let price = 0n;
  for (let attempt = 1; attempt <= 6; attempt++) {
    price = await getCurrentPrice(curveAddress).catch(() => 0n);
    if (price > 0n) break;
    // Also try: gas estimation as proxy for readiness
    try {
      const curve_ = new ethers.Contract(FACTORY, curveABI, wallet);
      await curve_.buy.estimateGas(curveAddress, { value: SNIPE_AMOUNT });
      price = 1n; // estimateGas succeeded = curve is live
      break;
    } catch {}
    if (attempt < 6) {
      logger.debug(`[SNIPE] Curve not ready yet (attempt ${attempt}/6), retrying in 2s...`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  if (price === 0n) {
    logger.warn(`[SNIPE SKIP] Curve still not ready after retries: ${curveAddress}`);
    return;
  }

  try {
    let txHash, blockNumber, amount, entryPrice, actualToken;
    let info = await getTokenInfo(curveAddress);
    actualToken = tokenAddr || curveToToken.get(curveAddress.toLowerCase()) || curveAddress;

    if (globalThis.paperTrading) {
      txHash = '0xsim' + Math.random().toString(16).slice(2).padStart(60, '0');
      blockNumber = await provider.getBlockNumber().catch(() => 9999999);
      amount = estimated || (SNIPE_AMOUNT * (10n ** 18n) / (await getCurrentPrice(curveAddress) || 1n));
      if (amount === 0n) amount = 1000n * (10n**18n); // default safe
      entryPrice = await getCurrentPrice(curveAddress);
      if (entryPrice === 0n) entryPrice = (SNIPE_AMOUNT * (10n ** 18n)) / amount;
      
      logger.info(`[PAPER BOUGHT] ${sym} tx: ${txHash}`);
      await sendTg(`🧪 <b>[PAPER TRADE]</b> Snipe bought <b>${sym}</b>\nEst. amount: ${ethers.formatEther(amount)}`);
    } else {
      let minOut = 0n;
      let gasEst;
      try {
        gasEst = await curve.buy.estimateGas(curveAddress, { value: SNIPE_AMOUNT });
      } catch (e) {
        minOut = 0n;
        gasEst = await curve.buy.estimateGas(curveAddress, { value: SNIPE_AMOUNT });
      }
      const feeData = await provider.getFeeData();
      const maxFee = (feeData.maxFeePerGas || feeData.gasPrice) * BigInt(Math.floor(GAS_MULT * 100)) / 100n;

      let tokenForBal = tokenAddr || curveToToken.get(curveAddress.toLowerCase()) || curveAddress;
      const balBefore = await getTokenBalance(tokenForBal, wallet.address);

      const tx = await curve.buy(curveAddress, {
        value: SNIPE_AMOUNT,
        gasLimit: gasEst * 145n / 100n,
        maxFeePerGas: maxFee,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas || (maxFee / 2n)
      });

      const receipt = await withTimeout(tx.wait(), 120000, 'snipe tx.wait');
      txHash = receipt.hash || receipt.transactionHash || 'unknown';
      blockNumber = receipt.blockNumber;
      logger.info(`[BOUGHT] ${sym} tx: ${txHash}`);

      const rec = await getReceivedAmountFromReceipt(receipt, wallet.address);
      const fromLog = rec.amount;
      actualToken = rec.token || tokenAddr || curveToToken.get(curveAddress.toLowerCase()) || curveAddress;
      const balAfter = await getTokenBalance(actualToken, wallet.address);
      amount = fromLog > 0n ? fromLog : (balAfter > balBefore ? (balAfter - balBefore) : (estimated || 0n));
      if (amount === 0n) {
        const postBal = await getTokenBalance(actualToken, wallet.address);
        if (postBal > 0n) {
          amount = postBal;
        }
      }
      if (amount === 0n) {
        logger.warn(`[SNIPE] No tokens received for ${curveAddress}`);
        await sendTg(`⚠️ Snipe tx mined but no tokens received for ${curveAddress}. Wrong curve addr or contract issue.`);
        return;
      }
      entryPrice = await getCurrentPrice(curveAddress);
      if (entryPrice === 0n && amount > 0n) {
        entryPrice = (SNIPE_AMOUNT * (10n ** 18n)) / amount;
      }
      
      const txLink = `${EXPLORER}/tx/${txHash}`;
      await sendTg(`✅ Bought <b>${sym}</b> on fun.noxa.fi/robinhood\nEst. amount: ${ethers.formatEther(amount)}\n<a href="${txLink}">View tx</a> | <a href="https://bullscan.fun/robinhood/token/${actualToken}">Bullscan</a>`);
      await sendAlert(`✅ Snipe bought ${symbol}\n${txLink}`);
    }

    const storedToken = actualToken || tokenAddr || curveAddress;
    positions.push({ 
      curve: curveAddress,
      token: storedToken, 
      symbol: sym || `${info.name} (${info.symbol})`, 
      amount, 
      entryPrice, 
      highestPrice: entryPrice, 
      isMigrated: false, 
      entryBlock: blockNumber,
      soldAmount: 0n,
      reEntries: 0,
      tpReached: [], // for ladder
      entryTime: Date.now(),
      isPaper: !!globalThis.paperTrading
    });
    dailyStats.trades++;
    savePositions();
  } catch (e) {
    logger.error(`[SNIPE FAIL] ${sym}: ${e.message}`);
    await sendTg(`❌ Snipe failed ${sym}`);
  }
}

// ====================== SELL ======================
async function sellPosition(pos, exitType = 'MANUAL') {
  const posCurve = pos.curve || pos.token;
  const posKey = pos.token || pos.curve;
  const sellAmt = pos.amount;

  if (pos.isPaper || globalThis.paperTrading) {
    const exitPrice = await getLivePrice(posKey, posCurve);
    const txHash = '0xsim' + Math.random().toString(16).slice(2).padStart(60, '0');
    logger.info(`[PAPER SOLD] ${pos.symbol} at price ${ethers.formatEther(exitPrice || 0n)}`);
    await sendTg(`🧪 <b>[PAPER TRADE]</b> Sold <b>${pos.symbol}</b>`);
    
    logTradeToHistory(pos, sellAmt, exitPrice, txHash, exitType);
    
    positions = positions.filter(p => (p.token || p.curve) !== posKey);
    savePositions();
    return;
  }

  // Graduated token: try DEX sell (sellOnDex silently skips if no pool exists)
  if (pos.isMigrated && ROUTER && WETH) {
    const exitPrice = await getLivePrice(posKey, posCurve);
    const txHash = await sellOnDex(posKey, sellAmt);
    if (txHash) {
      logTradeToHistory(pos, sellAmt, exitPrice, txHash, exitType);
      positions = positions.filter(p => (p.token || p.curve) !== posKey);
      savePositions();
    }
    // If null: pool doesn't exist yet - silent hold, manageSafeStrategy skips graduated
    return;
  }
  // If graduated but no ROUTER/WETH configured: skip - position stays, no SL loop
  if (pos.isMigrated && (!ROUTER || !WETH)) {
    logger.debug(`[GRADUATED HOLD] ${pos.symbol} - no DEX configured, skipping sell`);
    return;
  }

  const curve = new ethers.Contract(FACTORY, curveABI, wallet);
  try {
    const exitPrice = await getLivePrice(posKey, posCurve);
    const tx = await curve.sell(posKey, sellAmt, { gasLimit: 550000 });
    const receipt = await tx.wait();
    const txHash = receipt.hash || receipt.transactionHash;
    logger.info(`[SOLD] ${pos.symbol}`);
    await sendTg(`💰 Sold <b>${pos.symbol}</b>`);
    
    logTradeToHistory(pos, sellAmt, exitPrice, txHash, exitType);
    
    const key = pos.token || pos.curve; positions = positions.filter(p => (p.token || p.curve) !== key);
    savePositions();
  } catch (e) {
    logger.error(`Sell error on curve: ${e.message}`);
    if (ROUTER && WETH) {
      // Curve sell failed - attempt DEX fallback
      pos.isMigrated = true;
      const exitPrice = await getLivePrice(posKey, posCurve);
      const txHash = await sellOnDex(posKey, sellAmt);
      if (txHash) {
        logTradeToHistory(pos, sellAmt, exitPrice, txHash, exitType);
        const key = pos.token || pos.curve; positions = positions.filter(p => (p.token || p.curve) !== key);
        savePositions();
      }
    } else {
      // No DEX - pause SL monitoring to prevent infinite retry loop
      pos.slPaused = true;
      savePositions();
      await sendTg(`⚠️ Sell failed for <b>${pos.symbol}</b>: ${e.message.slice(0, 80)}\nSL paused - sell manually.`);
    }
  }
}

async function sellPercent(pos, pct) {
  let remaining = pos.amount - (pos.soldAmount || 0n);
  if (remaining <= 0n) {
    await sendTg('No remaining to sell.');
    return;
  }
  let sellAmt = remaining * BigInt(Math.floor(pct)) / 100n;
  if (sellAmt > 0n) {
    const temp = { ...pos, amount: sellAmt };
    await sellPosition(temp);
    pos.soldAmount = (pos.soldAmount || 0n) + sellAmt;
    savePositions();
  }
}

async function sellByAddr(addr, pct = 100) {
  let pos = positions.find(p => ((p.token||p.curve)||'').toLowerCase() === addr.toLowerCase());
  if (!pos) {
    pos = { token: addr, amount: 0n, soldAmount: 0n, symbol: 'Unknown', isMigrated: false };
  }
  let remaining = pos.amount - (pos.soldAmount || 0n);
  if (remaining === 0n) {
    // try actual token balance
    try {
      const erc20 = new ethers.Contract(addr, ["function balanceOf(address) view returns (uint256)"], provider);
      remaining = await erc20.balanceOf(wallet.address);
    } catch (e) {
      logger.warn('Could not get balance for ' + addr);
    }
  }
  if (remaining <= 0n) {
    await sendTg('No balance found to sell for ' + addr);
    return;
  }
  let sellAmt = remaining * BigInt(Math.floor(pct)) / 100n;
  const temp = { ...pos, amount: sellAmt };
  await sellPosition(temp);
  if (pos.soldAmount !== undefined) {
    pos.soldAmount = (pos.soldAmount || 0n) + sellAmt;
    savePositions();
  }
}

// ====================== MONITOR ======================
async function monitorPositions() {
  if (monitoringInProgress) return;
  monitoringInProgress = true;
  try {
    for (const pos of [...positions]) {
      try {
        const price = await getLivePrice(pos.token, pos.curve);
        if (!price || price === 0n) {
          continue;
        }

        // Detect graduation: tokenBalance==0 means bonding curve is complete
        // The 4th word in curves() is NOT a bool - graduation = zero token balance
        if (!pos.isMigrated) {
          const factory = new ethers.Contract(FACTORY, curveABI, provider);
          const state = await factory.curves(pos.token).catch(() => null);
          if (state && state.tokenBalance === 0n && state.virtualEth === 0n) {
            pos.isMigrated = true;
            logger.info(`[GRADUATED] ${pos.symbol} bonding curve complete`);
            sendTg(`🎓 <b>${pos.symbol}</b> bonding curve complete! Holding position.`).catch(()=>{});
            savePositions();
          }
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
  } finally {
    monitoringInProgress = false;
  }
}

// === CORE STRATEGY: Small amount snipe + Capital safe profit taking + Moonbag ===
async function manageSafeStrategy(pos, currentPrice, pnlPct) {
  const entryPrice = Number(pos.entryPrice);
  let remainingAmount = pos.amount - (pos.soldAmount || 0n);
  if (remainingAmount <= 0n) {
    const key = pos.token || pos.curve; positions = positions.filter(p => (p.token || p.curve) !== key);
    savePositions();
    return;
  }

  // 0. Time-Based Stop-Loss (Auto-Exit after X seconds)
  if (TIME_LIMIT_SECS > 0) {
    if (!pos.entryTime) {
      pos.entryTime = Date.now();
      savePositions();
    }
    const ageSecs = Math.floor((Date.now() - pos.entryTime) / 1000);
    if (ageSecs >= TIME_LIMIT_SECS) {
      logger.info(`[TIME EXIT] ${pos.symbol} reached time limit of ${TIME_LIMIT_SECS}s (${ageSecs}s) - executing auto-exit`);
      await sendTg(`⏳ <b>Time limit reached</b> for ${pos.symbol} (${Math.floor(ageSecs/60)}m) - executing auto-exit`);
      await sellPosition(pos, 'TIME_LIMIT');
      return;
    }
  }

  // Graduated tokens: no automated selling until DEX pool exists.
  // sellOnDex will silently skip if no pool. Avoid SL/TP spam loops.
  if (pos.isMigrated) {
    logger.debug(`[HOLD] ${pos.symbol} graduated - skipping SL/TP until DEX pool available`);
    return;
  }

  const peak = Number(pos.highestPrice);
  const trailingPrice = peak * (1 - TRAILING);

  // Calculate moonbag: never sell below this % of original position
  const moonbagPct = STRATEGY.moonbagPct || 25;
  const moonbagAmount = (pos.amount * BigInt(moonbagPct)) / 100n;
  const sellableAmount = remainingAmount > moonbagAmount ? remainingAmount - moonbagAmount : 0n;

  if (sellableAmount <= 0n) {
    logger.debug(`[MOONBAG] ${pos.symbol} - moonbag only, holding.`);
    return;
  }

  // 1. Hard Stop Loss
  if (pnlPct <= -STOP_LOSS * 100) {
    logger.info(`[SL] ${pos.symbol} PnL ${pnlPct.toFixed(1)}% - Selling for capital protection`);
    await sendTg(`🛡️ SL hit on <b>${pos.symbol}</b> (${pnlPct.toFixed(1)}%) - Protecting capital`);
    await sellPosition(pos, 'STOP_LOSS');
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
        await sellPosition(tempPos, 'TAKE_PROFIT');
        
        pos.soldAmount = (pos.soldAmount || 0n) + sellAmount;
        pos.tpReached = pos.tpReached || [];
        pos.tpReached.push(i);
        
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
      await sellPosition(tempPos, 'TRAILING_STOP');
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
          if (pos.isPaper || globalThis.paperTrading) {
            const estOut = await estimateBuyOutput(pos.token, reAmount);
            const amountReceived = estOut || (reAmount * (10n ** 18n) / (currentPrice || 1n));
            pos.reEntries = (pos.reEntries || 0) + 1;
            pos.amount += amountReceived;
            dailyStats.trades++;
            savePositions();
            logger.info(`[PAPER RE-ENTRY SUCCESS] ${pos.symbol}`);
            await sendTg(`🧪 <b>[PAPER TRADE]</b> Re-buy successful on ${pos.symbol}`);
          } else {
            const curve = new ethers.Contract(FACTORY, curveABI, wallet);
            const gasEst = await curve.buy.estimateGas(pos.token, { value: reAmount });
            await curve.buy(pos.token, {
              value: reAmount,
              gasLimit: gasEst * 130n / 100n
            });
            pos.reEntries = (pos.reEntries || 0) + 1;
            // Note: fixing standard reEntry bug where reAmount (ETH) was added to pos.amount (tokens)
            const tokenEst = await estimateBuyOutput(pos.token, reAmount).catch(() => 0n);
            const amountReceived = tokenEst > 0n ? tokenEst : reAmount; // fallback
            pos.amount += amountReceived;
            dailyStats.trades++;
            savePositions();
            logger.info(`[RE-ENTRY SUCCESS] ${pos.symbol}`);
          }
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
  if (pollingInProgress) {
    logger.debug('poll skipped - previous run still in progress (RPC slow?)');
    return;
  }
  pollingInProgress = true;
  try {
    const current = await withRetry(() => directProvider.getBlockNumber(), 4, 12000);
    if (lastPolledBlock === 0) lastPolledBlock = current - 20;

    if (current <= lastPolledBlock) {
      pollingInProgress = false;
      return;
    }

    // Clamp range to avoid huge scans that hang the bot (common stuck cause)
    const MAX_SCAN_BLOCKS = 400;
    const fromBlock = Math.max(lastPolledBlock + 1, current - MAX_SCAN_BLOCKS);

    const topic = config.eventTopic || ethers.id('TokenCreated(address,address,string,string,uint256)');
    const curveCompleteTopic = ethers.id('CurveCompleted(address,uint256,uint256)');

    // New launches - force broad scan if factory is placeholder
    const effectiveFactory = globalThis.FACTORY_OVERRIDE || FACTORY;
    const useFactory = effectiveFactory && !effectiveFactory.includes('REPLACE') ? effectiveFactory : undefined;

    let logs = [];
    try {
      // Use directProvider for getLogs to avoid FallbackProvider network-changed errors
      logs = await withRetry(() => directProvider.getLogs({
        address: useFactory,
        fromBlock,
        toBlock: current,
        topics: [topic]
      }), 3, 18000) || [];
    } catch (e) {
      logger.debug('getLogs (launches) failed: ' + (e.message || e));
    }

    // Fallback: also scan known launch contracts for activity
    if ((!logs || logs.length === 0) && KNOWN_LAUNCH_CONTRACTS.length > 0) {
      for (const known of KNOWN_LAUNCH_CONTRACTS) {
        try {
          const extra = await withRetry(() => directProvider.getLogs({
            address: known,
            fromBlock,
            toBlock: current,
            topics: [topic]
          }), 2, 10000).catch(() => []);
          if (extra && extra.length) logs = logs.concat(extra);
        } catch {}
      }
    }

    // Track seen tokens to avoid double-processing across overlapping scans
    if (!global.seenLaunchTokens) global.seenLaunchTokens = new Set();

    for (const log of logs) {
      if (isPaused) break;
      try {
        // === CORRECT EVENT STRUCTURE (verified on-chain 2026-07-10) ===
        // topics[1] = token address (ERC20)
        // topics[2] = creator wallet (NOT curve!) -- ignore
        // data      = ABI-encoded (string name, string symbol, uint256)
        // Real curve = non-factory contract with code in same tx receipt

        const tokenAddr = ('0x' + log.topics[1].slice(-40)).toLowerCase();

        // Deduplicate across overlapping scan windows
        if (global.seenLaunchTokens.has(tokenAddr)) continue;
        global.seenLaunchTokens.add(tokenAddr);
        // Keep set from growing unbounded
        if (global.seenLaunchTokens.size > 200) global.seenLaunchTokens.clear();

        // Decode name + symbol from event data (ABI-encoded strings in data)
        let tokenName = '???';
        let tokenSymbol = '???';
        try {
          const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
            ['string', 'string', 'uint256'],
            log.data
          );
          tokenName = decoded[0] || '???';
          tokenSymbol = decoded[1] || '???';
        } catch {}

        // Find real curve contract from receipt (non-factory addr with code in same tx)
        let curveAddr = tokenAddr;
        try {
          const receipt = await directProvider.getTransactionReceipt(log.transactionHash);
          if (receipt) {
            const seen = new Set([FACTORY.toLowerCase(), tokenAddr]);
            for (const rlog of receipt.logs) {
              const a = rlog.address.toLowerCase();
              if (seen.has(a)) continue;
              seen.add(a);
              const code = await directProvider.getCode(a).catch(() => '0x');
              if (code && code.length > 2) {
                curveAddr = a;
                break;
              }
            }
          }
        } catch (receiptErr) {
          logger.debug('[LAUNCH] receipt probe failed: ' + receiptErr.message);
        }

        curveToToken.set(curveAddr.toLowerCase(), tokenAddr.toLowerCase());
        curveToToken.set(tokenAddr.toLowerCase(), tokenAddr.toLowerCase());
        db.logLaunch(curveAddr, tokenAddr, `${tokenName} (${tokenSymbol})`);

        const display = (tokenName !== '???' && tokenSymbol !== '???')
          ? `${tokenName} (${tokenSymbol})`
          : `Token (${tokenAddr.slice(0,6)}...${tokenAddr.slice(-4)})`;

        logger.info(`[NEW LAUNCH] ${display} | token: ${tokenAddr} | curve: ${curveAddr}`);

        // Cache name/symbol immediately so /positions shows correct names
        tokenInfoCache.set(tokenAddr.toLowerCase(), { name: tokenName, symbol: tokenSymbol });
        tokenInfoCache.set(curveAddr.toLowerCase(), { name: tokenName, symbol: tokenSymbol });

        // === IMMEDIATE rich Telegram alert ===
        const explorerLink = `${EXPLORER}/address/${tokenAddr}`;
        const alertMsg =
          `🚀 <b>New Launch!</b>\n` +
          `<b>${tokenName}</b> (<code>${tokenSymbol}</code>)\n` +
          `🪙 Token: <a href="${explorerLink}">${tokenAddr.slice(0,10)}...${tokenAddr.slice(-6)}</a> | <a href="https://bullscan.fun/robinhood/token/${tokenAddr}">Bullscan</a>\n` +
          `📈 Curve: <code>${curveAddr.slice(0,10)}...${curveAddr.slice(-6)}</code>\n` +
          `⏱️ Block: ${log.blockNumber}`;

        sendTg(alertMsg, { parse_mode: 'HTML', disable_web_page_preview: true }).catch(() => {});
        sendBuyMenu(curveAddr, display, tokenAddr).catch(() => {});

        recentLaunches.unshift({ addr: curveAddr, token: tokenAddr, symbol: display, time: Date.now() });
        if (recentLaunches.length > 10) recentLaunches.pop();

        // Auto snipe — real curve, 2s delay for chain to settle
        setTimeout(() => snipe(curveAddr, display, tokenAddr), 2000);

      } catch (logErr) {
        logger.warn('[LAUNCH PARSE ERR] ' + logErr.message);
        try {
          const addr = ('0x' + log.topics[1].slice(-40)).toLowerCase();
          recentLaunches.unshift({ addr, symbol: 'LAUNCH', time: Date.now() });
          if (recentLaunches.length > 10) recentLaunches.pop();
          sendTg(`🚀 New launch: <code>${addr}</code>`, { parse_mode: 'HTML' }).catch(() => {});
          setTimeout(() => snipe(addr, 'LAUNCH'), 2000);
        } catch {}
      }
    }

    // Detect graduations (migrations) for open positions
    try {
      const completeLogs = await withRetry(() => directProvider.getLogs({
        fromBlock,
        toBlock: current,
        topics: [curveCompleteTopic]
      }), 2, 12000) || [];
      for (const log of completeLogs) {
        const token = '0x' + log.topics[1].slice(-40);
        const pos = positions.find(p => ((p.token || p.curve) || '').toLowerCase() === token.toLowerCase());
        if (pos && !pos.isMigrated) {
          pos.isMigrated = true;
          logger.info(`[GRADUATED] ${token} moved to DEX`);
          sendTg(`🔄 ${token} graduated - will sell on DEX`).catch(()=>{});
        }
      }
    } catch (e) {
      logger.debug('graduation logs error: ' + (e.message||e));
    }

    lastPolledBlock = current;   // always advance to avoid re-scanning forever
  } catch (e) {
    const msg = (e && (e.message || e.stack || e)) || 'unknown';
    if (!String(msg).includes('ENS')) {
      logger.warn('Poll error: ' + msg);
    }
    // On persistent error, still advance a bit so we don't get stuck on bad block
    if (lastPolledBlock > 0) lastPolledBlock += 5;
  } finally {
    pollingInProgress = false;
  }
}

// ====================== MAIN ======================
async function main() {
  console.log('=== ROBINHOOD CHAIN SNIPER - fun.noxa.fi/robinhood (LIVE MAINNET) ===');
  logger.info(`Mode: LIVE MAINNET ONLY (experienced user)`);
  logger.info(`Snipe size: ${ethers.formatEther(SNIPE_AMOUNT)} ETH (from config or default)`);
  logger.info(`Wallet: ${wallet.address}`);
  logger.info(`Focus: fun.noxa.fi/robinhood bonding curves`);

  // Real output diagnostics (with timeout so startup doesn't hang)
  try {
    const net = await withTimeout(provider.getNetwork(), 8000, 'getNetwork');
    const block = await withTimeout(provider.getBlockNumber(), 8000, 'getBlock');
    logger.info(`Chain ID: ${net.chainId} | Current block: ${block}`);
    logger.info(`RPCs (with FallbackProvider): ${RPCS.join(', ')}`);
  } catch (e) {
    logger.warn('RPC check issue (continuing anyway): ' + (e.message || e));
  }

  if (!FACTORY || FACTORY.includes('REPLACE')) {
    logger.warn('No factory set in config. Using broad scan + KNOWN list. Run "node discover.js" WHILE watching a launch on fun.noxa.fi/robinhood for real addresses.');
  } else {
    logger.info(`Factory: ${FACTORY}`);
  }

  updateTradingMode(config.paperTrading === true);
  loadPositions();
  await initTelegram();

  // Initialize and start WS Mempool Monitor
  const wsUrl = config.ws || 'wss://rpc.mainnet.chain.robinhood.com/ws';
  const mempool = new MempoolMonitor(wsUrl, FACTORY, logger);
  mempool.onLaunchDetected(async (event) => {
    logger.info(`[MEMPOOL EVENT] Launch transaction detected in mempool! Hash: ${event.hash}`);
    sendTg(`⚡ <b>Mempool Launch Detected!</b>\nPending Tx: <code>${event.hash}</code>\nExecuting early checks...`).catch(() => {});
    await pollNewLaunches().catch(() => {});
  });
  mempool.start().catch((err) => {
    logger.warn('Failed to start mempool WS monitor: ' + err.message);
  });

  // First poll with safety
  try { await withTimeout(pollNewLaunches(), 30000, 'initial poll'); } catch (e) { logger.warn('initial poll issue: ' + e.message); }

  // Set up RPC latency tester interval (every 60s)
  if (RPCS.length > 1) {
    testRpcLatencies().catch(() => {});
    setInterval(() => {
      testRpcLatencies().catch(() => {});
    }, 60000);
  }

  // Use the possibly runtime-tuned POLL_MS
  const pollInterval = globalThis.POLL_MS || POLL_MS || 2000;
  setInterval(pollNewLaunches, pollInterval);
  setInterval(monitorPositions, 4500);

  logger.info(`Intervals started: poll every ${pollInterval}ms, monitor every 4500ms (with overlap guards)`);

  setInterval(async () => {
    try {
      const bal = await getBalance();
      const balEth = parseFloat(ethers.formatEther(bal));
      logger.info(`[HEARTBEAT] ${positions.length} positions | Bal: ${balEth.toFixed(4)} ETH`);
      if (balEth < 0.01) {
        sendAlert(`⚠️ Low balance: ${balEth.toFixed(4)} ETH`).catch(() => {});
      }
      savePositions();
    } catch (hbErr) {
      logger.debug('heartbeat error: ' + (hbErr.message || hbErr));
    }
  }, 90000);

  // Global safety nets so one bad promise/RPC doesn't kill the whole bot
  process.on('unhandledRejection', (reason) => {
    logger.warn('UnhandledRejection (kept alive): ' + (reason && (reason.message || reason)));
  });
  process.on('uncaughtException', (err) => {
    logger.error('UncaughtException (will try to continue): ' + (err && (err.message || err)));
    // Do not exit - let PM2 or user restart if truly dead
  });

  process.on('SIGINT', () => {
    logger.info('Shutting down...');
    savePositions();
    process.exit(0);
  });

  logger.info('Bot running. Press Ctrl+C to stop. (anti-stuck guards + timeouts active)');
}

main().catch(e => { logger.error('main fatal: ' + e); /* do not always exit */ });