# Robinhood Chain (4663) + fun.noxa.fi Sniper Bot

**FULL UPGRADED v1.1 — Production sniper focused on https://fun.noxa.fi/robinhood**

This is the complete upgraded version for the NOXA Fun bonding curve launchpad on Robinhood Chain.

**Key upgrades:**
- Strong focus on fun.noxa.fi/robinhood
- Pre-snipe safety + better curve interaction
- Auto migration detection to DEX
- Full risk management + PnL
- Optional Telegram alerts (ready — add your token + chat ID)
- CLI flags + robust RPC handling
- PM2 ready for VPS

**⚠️ WARNING** — Only use with money you can afford to lose. Always start in dry-run.

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

**Testnet**: Chain ID 46630, RPC https://rpc.testnet.chain.robinhood.com (use for testing if available).

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

# 6. Run bot (dry run first!)
node robinhood_bot.js
```

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
- `dryRun`: true  (simulates, no real txs)
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
- Safety limits and dry-run mode

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

## GitHub / References (adapt from prompt)

See the original prompt for a list of Pump.fun-like and EVM bot repos. Replace addresses and adapt ABIs.

**Always verify live on-chain data yourself.**

---

*Educational use only. DYOR. Trade responsibly. Addresses and contracts change.*
