const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const LAUNCHES_FILE = path.join(DATA_DIR, 'launches.json');
const SAFETY_FILE = path.join(DATA_DIR, 'safety_logs.json');
const TRADES_FILE = path.join(__dirname, 'trades_history.json'); // compatibility with existing history file
const PAPER_TRADES_FILE = path.join(__dirname, 'paper_trades_history.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJSON(file) {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch (e) {
    console.error(`DB Manager read error for ${file}:`, e.message);
  }
  return [];
}

function writeJSON(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    return true;
  } catch (e) {
    console.error(`DB Manager write error for ${file}:`, e.message);
    return false;
  }
}

module.exports = {
  // Launches database APIs
  logLaunch(curveAddress, tokenAddress, symbol) {
    const list = readJSON(LAUNCHES_FILE);
    const exists = list.find(l => l.curve === curveAddress || l.token === tokenAddress);
    if (!exists) {
      list.push({
        curve: curveAddress,
        token: tokenAddress,
        symbol: symbol || 'Unknown',
        timestamp: Date.now()
      });
      // Cap at 200 launches to prevent huge files
      if (list.length > 200) list.shift();
      writeJSON(LAUNCHES_FILE, list);
    }
  },

  getRecentLaunches(limit = 10) {
    const list = readJSON(LAUNCHES_FILE);
    return list.slice(-limit).reverse();
  },

  // Safety scanner logs
  logSafetyCheck(tokenAddress, checks) {
    const list = readJSON(SAFETY_FILE);
    list.push({
      token: tokenAddress,
      timestamp: Date.now(),
      ...checks
    });
    if (list.length > 300) list.shift();
    writeJSON(SAFETY_FILE, list);
  },

  getSafetyLog(tokenAddress) {
    const list = readJSON(SAFETY_FILE);
    return list.find(l => l.token.toLowerCase() === tokenAddress.toLowerCase());
  },

  // Trades database APIs (reads/writes to trades_history.json or paper_trades_history.json)
  logTrade(tradeRecord, isPaper = false) {
    const file = isPaper ? PAPER_TRADES_FILE : TRADES_FILE;
    const list = readJSON(file);
    list.push({
      timestamp: Date.now(),
      ...tradeRecord
    });
    writeJSON(file, list);
  },

  getTradeHistory(limit = 10, isPaper = false) {
    const file = isPaper ? PAPER_TRADES_FILE : TRADES_FILE;
    const list = readJSON(file);
    return list.slice(-limit).reverse();
  },

  clearTradeHistory(isPaper = false) {
    const file = isPaper ? PAPER_TRADES_FILE : TRADES_FILE;
    writeJSON(file, []);
  },

  // Win/Loss metrics calculator
  getWinRateStats(isPaper = false) {
    const file = isPaper ? PAPER_TRADES_FILE : TRADES_FILE;
    const trades = readJSON(file);
    if (!trades || trades.length === 0) {
      return { totalRealizedPnl: 0, totalTrades: 0, wins: 0, losses: 0, winRate: 0 };
    }
    const totalRealizedPnl = trades.reduce((sum, t) => sum + (parseFloat(t.pnlEth) || 0), 0);
    const totalTrades = trades.length;
    const wins = trades.filter(t => (parseFloat(t.pnlEth) || 0) > 0).length;
    const losses = trades.filter(t => (parseFloat(t.pnlEth) || 0) <= 0).length;
    const winRate = (wins / totalTrades) * 100;
    return { totalRealizedPnl, totalTrades, wins, losses, winRate };
  }
};
