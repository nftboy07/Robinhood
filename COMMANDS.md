# Robinhood Sniper - Real Output Giving Commands (VPS + Local)

All commands below are designed to produce **real, useful output** (blocks, txs, balances, logs, TG responses, discovered addresses).

**Important**:
- Run these **after** `git pull` on VPS.
- Always have your `.env` with real PK + TG vars (via `nano .env` on VPS).
- Use a dedicated small-balance wallet.
- For discovery: keep https://fun.noxa.fi/robinhood open and watch for a new token launch while running commands.

---

## 1. SSH into VPS (copy-paste, replace your PEM)

```bash
# Example (use the key that worked when you set up the VPS)
ssh -i ~/.ssh/your_key.pem ubuntu@3.69.242.140
```

Once inside:

```bash
cd ~/robinhood-bot
```

---

## 2. Pull Latest Code + Restart (always do this first)

```bash
cd ~/robinhood-bot
git pull origin main
npm install --production
pm2 restart robinhood-sniper --update-env
pm2 logs robinhood-sniper --lines 20
```

**Expected real output**:
- Git pull messages
- PM2 restarting
- Bot startup logs with:
  - Wallet address
  - Snipe size
  - Chain ID + **current block number** (real!)
  - "LIVE MAINNET ONLY"
  - Heartbeat messages

---

## 3. Discovery Commands (Most Important for Real Addresses)

**Critical**: While running these, be on the website and either create a test launch or watch an active one. This produces real tx hashes and contract addresses.

```bash
cd ~/robinhood-bot
node discover.js
```

**Better - with more lookback for real recent activity**:

```bash
node discover.js --lookback 8000
```

**Real-time watch while on site** (run in one terminal, browse in another):

```bash
watch -n 5 "node discover.js --lookback 3000 2>&1 | tail -30"
```

After running, copy the **"READY CONFIG SNIPPET"** printed at the end.

Then:

```bash
nano config.json
# Paste and edit the factory / weth / router from the output
```

Verify:

```bash
cat config.json | grep -E 'factory|weth|router|snipeAmount'
```

---

## 4. Bot Startup & Real Diagnostics (gives live chain data)

Start manually for full console output (great for first test):

```bash
cd ~/robinhood-bot
node robinhood_bot.js
```

**Stop with Ctrl+C**

**What real output you will see**:
- Current block number
- Wallet address
- Snipe amount
- If factory missing: warning + suggestion
- `[NEW LAUNCH]` when one is detected
- Buy confirmations with tx hashes

---

## 5. PM2 Real Monitoring Commands

```bash
# Live logs (real events as they happen)
pm2 logs robinhood-sniper

# Last 100 lines (great for seeing recent activity)
pm2 logs robinhood-sniper --lines 100

# Filter for launches / buys / sells (real output)
pm2 logs robinhood-sniper --lines 200 | grep -E "(NEW LAUNCH|BOUGHT|SOLD|LAUNCH|HEARTBEAT|Error)"

# Current PM2 status
pm2 status

# Restart after config change
pm2 restart robinhood-sniper --update-env
```

---

## 6. Telegram Commands (send these to your bot - they give real output)

From the bot chat:

- `/menu` or `/m` → full button menu + persistent keyboard
- `/s` or `/status` → **real** balance, positions, PnL, wallet link
- `/p` or `/positions` → list with sold amounts + individual sell buttons
- `/sa` or `/sellall`
- `/poll` → forces poll, shows if new launches found
- `/r` or `/recent` → recent detected tokens + buy buttons
- `/bal` → balance
- `/d` or `/diag` or `/info` → **Real diagnostics** (current block, balance, snipe size, factory status, live data)
- `/buy <amt> <addr>` → manual buy (with honeypot check)
- `/forcebuy <amt> <addr>` → **force buy** (bypass honeypot and use 0 minOut - for when normal buy reverts)
- `/pause` / `/resume`

**New/Improved output**:
- All buy messages now include clickable Blockscout tx links.
- Status shows clickable wallet address.

---

## 7. Quick On-Chain Checks (Real Data, No Full Bot Needed)

These use the RPC directly and give live output.

```bash
# Current block (real)
node -e '
const {ethers} = require("ethers");
const p = new ethers.JsonRpcProvider("https://rpc.mainnet.chain.robinhood.com");
p.getBlockNumber().then(b => console.log("Current block:", b));
'

# Wallet balance (replace with your funded address from bot logs)
node -e '
const {ethers} = require("ethers");
const p = new ethers.JsonRpcProvider("https://rpc.mainnet.chain.robinhood.com");
const addr = "0xYOUR_WALLET_ADDRESS_HERE";
p.getBalance(addr).then(b => console.log("Balance:", ethers.formatEther(b), "ETH"));
'

# Check if a suspected factory has code
node -e '
const {ethers} = require("ethers");
const p = new ethers.JsonRpcProvider("https://rpc.mainnet.chain.robinhood.com");
p.getCode("0xREPLACE_FACTORY").then(code => {
  console.log("Factory code length:", code.length);
  console.log("Has code?", code !== "0x");
});
'
```

---

## 8. TG Diag + VPS Real Diag (tests + live chain data)

```bash
cd ~/robinhood-bot
node tg_diag.js
```

```bash
# New: real output without starting the full bot (current block, balance, config)
node vps_diag.js
```

**Expected real output**:
- Bot username + ID
- Webhook info
- Current live block number
- Wallet balance
- Config status (factory set?)
- Positions count from file

---

## 9. Config & Environment Checks

```bash
# Show key config (safe - no PK)
cat config.json | grep -E '"(rpc|factory|weth|router|snipeAmountEth|stopLossPct)"'

# Check .env exists and has keys (do not print values)
ls -l .env
cat .env | grep -E '^(PK|TELEGRAM|ADMIN)' | cut -d= -f1

# Permissions (should be 600)
ls -l .env
```

---

## 10. After First Real Launch (verify everything)

1. Run `pm2 logs robinhood-sniper --lines 50`
2. Look for:
   - `[NEW LAUNCH]`
   - `[SNIPE]`
   - `[BOUGHT]` + tx hash + link
3. In TG: `/p` to see the position
4. Check explorer link from the message

---

## Quick One-Command "Everything Check"

Paste this after logging into VPS:

```bash
cd ~/robinhood-bot && \
echo "=== GIT ===" && git status --short && \
echo "=== CONFIG KEYS ===" && cat config.json | grep -E 'factory|weth|router|snipe' && \
echo "=== PM2 ===" && pm2 status && \
echo "=== LAST LOGS ===" && pm2 logs robinhood-sniper --lines 10
```

---

**Next after running these**:
- Get real factory/weth/router from `node discover.js`
- Update `config.json`
- Restart PM2
- Send `/menu` in Telegram
- Wait for or trigger a launch

Run the commands above and paste the **real output** you get back here if you want help interpreting addresses or fixing something.

All commands above are safe and designed to show you actual on-chain + bot data.