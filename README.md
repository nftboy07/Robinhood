# Robinhood Chain (4663) + fun.noxa.fi Sniper Bot

**FULL UPGRADED — Automatic Meme Sniper for https://fun.noxa.fi/robinhood (Bonding Curve)**

## SAFE AUTOMATIC MEME SNIPING STRATEGY (Implemented)

**Core Philosophy**: Tiny entries (0.0001 ETH) to minimize risk, aggressive but safe profit taking via ladder + trailing, quick capital protection on losses, limited averaging on dips, full auto on curve → DEX.

**Snipe Amount**: Fixed small **0.0001 ETH** per new launch (configurable, ~$0.15-0.30 depending on ETH price). Never risk big on one meme.

**Entry**:
- Auto-detect new launches via poll on fun.noxa.fi factory/events.
- Immediate snipe on curve (first-mover advantage).
- Honeypot/gas check before buy.
- Only snipe if curve progress is reasonable (early-mid).

**Profit Taking & Capital Safety + Moonbag**:
- **TP Ladder**: Sell 30% at +50%, 30% at +100%, 40% at +200% (configurable).
- **Trailing Stop**: Trail remaining by 25% from peak to lock profits.
- **Hard Stop Loss**: Sell all at -20% to protect capital fast (no bag holding).
- **Re-Entry on Dip**: If drops 30%+ from entry, add tiny 0.00005 ETH (max 2x per position) to lower average.
- **Moonbag**: Configurable % (default 25%) of original position is **never auto-sold**. Left to ride potential moonshots after DEX migration.
- **Post-Graduation**: Auto switch to DEX sell for the non-moonbag portion when curve completes (liquidity added).

**Risk Controls**:
- Max 10 concurrent positions.
- Max daily loss 5% (stops sniping).
- Max 20 trades/hour.
- Max re-entries limited.
- **LIVE MAINNET ONLY** (no dry-run). You are experienced, use tiny entries on mainnet only.

**Automation**:
- Runs 24/7 via PM2 on VPS.
- Continuous fast polling (800ms).
- Full TG buttons for control (/menu).
- Logs every decision.

This keeps capital safe while compounding small wins on meme launches.

**Important for you:**
- I handle **ALL** GitHub work (commits, pushes) and **ALL** VPS work (pull, install, config, PM2, restarts).
- You **only** give me sensitive information (Private Key, Telegram Bot Token, Chat ID, and real contract addresses) through `.env` files.
- Never paste secrets in chat except when instructing me to put them in .env.

### Leak-Proof / Security (Completed)
- `.env`, `config.json`, `positions.json` are in `.gitignore` and **never committed**.
- On VPS: `.env` has `chmod 600` (owner read/write only), owned by `ubuntu`.
- Bot code loads PK only via `process.env.PK` at runtime — never logged or embedded.
- PM2 does not dump secrets (dotenv runtime load).
- Local scans: no real 64-char hex PKs in source (only placeholders in .example files).
- Always use a dedicated hot wallet with minimal funds.
- On Windows: restrict .pem and .env with icacls if needed (e.g. `icacls .env /inheritance:r /grant %USERNAME%:R`).
- For extra: consider `dotenvx` or system secrets (but current setup is standard and audited).

**Funded wallet (~$500 ETH):** Use the address printed by the bot on start (or run the node command above). The bot is now live with real funds using the 0.0001 ETH safe strategy.

This is the complete upgraded version for the NOXA Fun bonding curve launchpad on Robinhood Chain (4663).

**Key upgrades:**
- Strong focus on fun.noxa.fi/robinhood
- Pre-snipe safety + better curve interaction
- Auto migration detection to DEX
- Full risk management + PnL
- Optional Telegram alerts + commands (ready — add your token + chat ID)
- CLI flags + robust RPC handling
- PM2 ready for VPS
- Honeypot checks, daily loss limits, max trades per hour
- **Automatic safe strategy**: 0.0001 ETH snipes, TP ladder + trailing, re-entries on dips, capital protection SL (LIVE MAINNET)

This is a full vertical solution for:
- Monitoring new token launches on the bonding-curve style launchpad
- Fast sniping on the curve at launch
- Detecting graduation to Uniswap (or NOXA DEX)
- Automated sell via bonding curve or DEX router with SL/TP/trailing
- Multi-position management
- Robust polling (WS fallback) for ~0.1s block times

**⚠️ EXTREME RISK WARNING ⚠️**

- Meme coin trading / sniping is **highly speculative gambling**. The vast majority of participants lose money.
- New tokens on launchpads frequently rug, have honeypots, malicious code, or massive sell pressure.
- Using this bot with real funds can result in **total loss of capital**.
- Front-running / MEV attempts may not work or may be unreliable on this chain (FCFS sequencer).
- **Only use tiny test amounts** (e.g. 0.01-0.05 ETH max per snipe initially).
- **Never commit private keys to git or share them.**
- This code is provided **for educational and research purposes only**. The author assumes **no liability**.
- Always verify **all contract addresses** yourself on https://robinhoodchain.blockscout.com before any live use.
- Comply with all laws in your jurisdiction. Crypto trading may be restricted.

Test thoroughly on small amounts. Monitor first trades manually.

## Verified Chain Details (as of 2026-07-08)

| Parameter              | Value                                      |
|------------------------|--------------------------------------------|
| Chain Name             | Robinhood Chain (Mainnet)                  |
| Chain ID               | 4663 (0x1237)                              |
| Native / Gas Token     | ETH (18 decimals)                          |
| RPC (public)           | https://rpc.mainnet.chain.robinhood.com    |
| WebSocket (if avail.)  | wss://rpc.mainnet.chain.robinhood.com/ws   |
| Explorer               | https://robinhoodchain.blockscout.com      |
| Launchpad              | https://fun.noxa.fi/robinhood              |
| Average block time     | ~0.1s (very fast)                          |
| Notes                  | Arbitrum Orbit L2 by Robinhood. FCFS sequencing. Uniswap live. |

**Testnet**: (Not used - you only run mainnet live.) Chain ID 46630 info kept for reference only.

## How to Get the Critical Contract Addresses (MUST DO)

The placeholder addresses in older prompts are **invalid**. You **must** discover live ones:

1. **Factory / Launchpad contract** (emits creation events or handles launches)
   - Visit https://fun.noxa.fi/robinhood
   - In browser DevTools → Network → filter by `eth_` or the launchpad domain.
   - Initiate a launch (or watch a live launch) and note the `to` address of the main transaction (this is often the launch/factory).
   - Alternative: On Blockscout, find a brand new token's creation transaction. The "from" or internal "create" caller is often the launcher. Look for repeated caller across many new tokens.

2. **Bonding Curve / Per-token buy/sell contract**
   - For each new token, the curve logic may be in the token itself or a paired curve contract.
   - Inspect a buy transaction on a fresh token via explorer. Note the contract receiving the ETH buy.

3. **WETH**
   - Search "WETH" on the explorer or inspect a graduated Uniswap pair.
   - Common pattern on Orbit L2s: check recent Uniswap pairs.

4. **Uniswap V2 / DEX Router**
   - Uniswap is live on the chain. Find the Router address via Uniswap docs or by inspecting a swap tx on graduated tokens (search "swap" calls on explorer for popular pairs).

5. **Use the included `discover.js`** (after setup) to scan recent blocks for candidate launch events and common patterns.

**Recommended workflow**: Start the discovery script, watch a new launch on the site, note addresses from txs, plug into `config.json`.

## Project Structure

```
robinhood-bot/
├── package.json
├── .env.example
├── config.json.example
├── README.md
├── robinhood_bot.js     # Main production bot
├── discover.js          # Address & event discovery helper
└── positions.json       # Runtime (gitignored) position state
```

## Quick Start

```powershell
# 1. In this folder
npm install   # already done in setup

# 2. Copy configs
copy .env.example .env
copy config.json.example config.json

# 3. Edit .env with your PK (NEVER commit)
# 4. Edit config.json with REAL addresses from discovery

# 5. (Optional) Run discovery
node discover.js

# 6. Run bot (LIVE MAINNET ONLY - experienced)
node robinhood_bot.js
```

## Telegram Setup (ethbot style - clean & proven)

1. Create bot:
   - Open Telegram → @BotFather
   - /newbot → name + username (ends in bot)
   - Copy TELEGRAM_TOKEN (e.g. 123456789:ABCdef...)

2. Get ADMIN_CHAT_ID:
   - DM your bot (send "hi")
   - Browser: https://api.telegram.org/bot<TOKEN>/getUpdates
   - Find "chat":{"id": YOUR_ID}

3. .env (minimum):
   ```
   TELEGRAM_TOKEN=your_token
   ADMIN_CHAT_ID=your_id
   PK=0x...
   ```

   Aliases supported: BOT_TOKEN, TELEGRAM_CHAT_ID.

4. Test:
   ```
   node tg_diag.js
   ```

See tg_diag.js and sendAlert() in code for outbound alerts.
For full interactive (buttons/commands): polling bot is running.
```

## Telegram Commands (fast & usable)

Send `/menu` or `/start` for button menu + persistent quick keyboard.

**Short commands:**
- `/m` or `/menu`
- `/s` or `/status`
- `/p` or `/positions`
- `/sa` or `/sellall`
- `/r` or `/recent`
- `/poll`
- `/h` or `/help`

**Buttons (fast menu):**
- Status, Positions, Sell All, Poll Now, Recent, Test Buy, Config, Stop

New launches auto-post with token name + buy buttons (0.003 / 0.005 / 0.007 / 0.01 ETH).

Use `/menu` in your TG bot to see everything.

## Telegram Bot Commands & Buttons

The bot has a full Telegram interface (send `/menu` or `/start` to your bot to open it).

**Text commands:**
- `/menu` or `/start` — Open the main button menu
- `/status` — Show current positions, PnL, balance, mode (LIVE)
- `/positions` — List open positions (with per-position Sell buttons)
- `/help` — List commands

**Main Menu Buttons:**
- 📊 Status — Same as /status
- 📍 Positions — Same as /positions
- 💸 Sell All — Sell every open position
- 🔄 Force Poll — Manually scan for new launches
- ⚙️ Config — Show current settings
- 🛑 Stop Bot — Gracefully shut down the bot
- 📋 Recent Launches — List last ~5 detected tokens (click to open buy menu)
- 🔁 Refresh Menu — Re-send the menu

**When a new launch is detected:**
The bot automatically posts a message with:
- Real token name (or "Unnamed Meme Token (short address)" if none)
- Full address
- Explorer link
- Inline buy buttons: **0.003 | 0.005 | 0.007 | 0.01 | Auto 0.0001**

Click any button to execute a manual buy with that exact amount on the curve.

**Recent Launches** also gives you buy options for the last detected tokens.

All buttons are tied directly to the on-chain addresses from the launch events, so buying works even for tokens that have no on-chain name yet.

Environment:
```
PK=0xYOUR_PRIVATE_KEY_HERE
```

**Strongly recommended**: Use a dedicated hot wallet with small balance only.

## Configuration (config.json)

See `config.json.example`. Key fields:
- `rpc`, `ws`
- `factory`, `curveAbi` (minimal), `router`, `weth`
- `snipeAmountEth`
- `stopLossPct`, `takeProfitPct`, `trailingStopPct`
- `maxConcurrentPositions`
- `pollIntervalMs` (recommend 800-1500 for speed)
- `gasMultiplier`

## Features Implemented

- Fast HTTP polling for `TokenCreated` / launch events (tunable)
- Automatic buy on new curve with gas buffer + priority fee bump
- Real-time price monitoring (curve `getPrice()` or DEX reserves)
- SL / TP / Trailing stops
- Automatic switch to DEX sells post-graduation (when detected via events or price behavior)
- Persistent positions across restarts
- Heartbeat + structured logging (winston)
- Basic bundle fallback stub (note: may not be supported)
- Safety limits (LIVE mainnet mode)

## Production Tips for 4663

- Block times are extremely fast — use low poll interval and good RPC (consider private endpoint if rate limited).
- Gas: Use 1.5-2x on priority. The public RPC may be rate-limited; Alchemy/QuickNode support may be available.
- Max positions: Keep low (5-10) to avoid capital lockup.
- Monitor via explorer + Telegram bot for alerts (easy extension).
- Run with PM2 for 24/7: `pm2 start robinhood_bot.js --name rh-sniper`
- For multiple instances: different configs / keys.

## Troubleshooting

- `unknown chain id`: Use latest ethers (`npm install ethers@latest`).
- No events: The event signature may differ. Use `discover.js` and update ABI/topics.
- Revert on buy: Curve may enforce min buy, anti-snipe, or require specific `amountOutMin`.
- Rate limits: Add retries, use private RPC.
- "Cannot estimate gas": Token may not be snipable (blacklist, paused curve, etc.).

## Extending

- Add Telegram alerts (use `node-telegram-bot-api`)
- Add better math for bonding curve cost estimation (integrate curve formula if reverse-engineered)
- Honeypot / rug checks before snipe (use tx simulation or external APIs)
- Multi-wallet rotation

## Updating the bot on VPS (Live Mainnet)

After any code change (including this dry-run removal):

1. SSH to your VPS (use your PEM):
   ```
   ssh -i /path/to/your.pem ubuntu@3.69.242.140
   ```

2. Run these commands:
   ```
   cd ~/robinhood-bot
   git pull origin main
   npm install --production
   pm2 restart robinhood-sniper --update-env
   pm2 logs robinhood-sniper --lines 30
   ```

3. In Telegram: `/menu` or `/s` to confirm it's running the new version (no "DRY" anywhere).

Your `.env` and `config.json` stay untouched (they are gitignored). Only edit them with `nano` if you need to change PK/TG or factory addresses.

See:
- `VPS_UPDATE_COMMANDS.txt`
- `COMMANDS.md` (big list of commands that produce **real output** — blocks, txs, discovery, logs, TG responses)

Both in the repo root.

## GitHub / References (adapt from prompt)

See the original prompt for a list of Pump.fun-like and EVM bot repos. Replace addresses and adapt ABIs.

**Always verify live on-chain data yourself.**

---

*Educational use only. DYOR. Trade responsibly. Addresses and contracts change.*
