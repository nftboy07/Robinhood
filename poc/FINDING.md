# Finding: Unprivileged on-chain attacker drains the bot wallet via the shipped auto-buy default

**Program:** nftboy07/Robinhood (Robinhood LP Bot v2)
**Severity:** Critical (direct, unauthenticated theft of the hot wallet's ETH)
**Status:** PoC-proven (runnable, hermetic, no funds/accounts/live services touched)

## Summary

The bot ships with **autonomous buying enabled by default** and a chain listener that
sniper-buys *any* newly created WETH pool it sees on-chain. Because a pool can be created
permissionlessly by anyone, an unprivileged attacker can make the bot spend its real hot-wallet
ETH buying an attacker-controlled token at any price (zero slippage floor) and without a
honeypot check gating the trade, then drain the proceeds through their own pool. No Telegram
owner, no auth, and no operator interaction are required; merely deploying a token + pool triggers
the buy.

## Exact location

- Trigger: `src/radar/chainListener.ts` -> `pollNewPoolEvents()`. For every
  PoolCreated/PairCreated/Initialize log from the watched factories it calls, fire-and-forget:
  `maybeAutoLp({ token, symbol, source: "feed-new", fee, onchainBackPct: 100 }, { llm: { score: 98, action: "ape", ... }, gmgn: null })`
  i.e. it injects a hardcoded "score 98 / ape" verdict for an attacker-supplied token.
- Decision: `src/radar/autolp.ts` -> `maybeAutoLp()` / `executeSplitSnipe()`.
- Execution: `src/chain/swaps.ts` -> `swapWethToTokenMultiFire()` -> `sendExactInput()`, which builds the
  swap with `amountOutMinimum: 0n`.
- Shipped config: `config.json` commits `autoLp.enabled: true`, `mode: "buy"`, `requireLlm: false`,
  `requireGmgn: false`, `minScore: 30`, sources includes "feed-new" overriding the zod schema
  defaults in `src/config.ts` (which ship `autoLp.enabled: false`, described as "Default OFF").

## Root cause

1. **Shipped config enables unattended spending.** `src/config.ts` declares `autoLp.enabled`
   default false ("DANGEROUS (spends funds unattended)"), but the committed `config.json` sets it
   true with the gates effectively disabled (requireLlm:false, minScore:30, requireAction:"watch").
2. **Attacker-controlled input is trusted as a buy signal.** `pollNewPoolEvents` treats any
   new WETH pool as a candidate and fabricates a score 98 / ape verdict. Pool creation is
   permissionless, so the "signal" is fully attacker-controlled.
3. **Honeypot/security audit is deferred on "fast" sources.** In `maybeAutoLp`, when
   source === "feed-new" (set by the listener), `auditTokenSecurity()` is launched
   fire-and-forget and the buy proceeds before any result, so a honeypot is bought first and
   (maybe) blacklisted only afterwards.
4. **Zero slippage protection.** The buy is executed with `amountOutMinimum: 0n`, so the attacker
   can structure the pool so the bot receives near-nothing for its ETH (sandwich / thin pool / rug).

## Impact for an unprivileged attacker today

An attacker who can deploy a contract on Robinhood Chain (permissionless) can:

1. Deploy a worthless/honeypot token and create a WETH pool on a watched factory.
2. Within one poll cycle the bot auto-buys the token with its hot-wallet ETH (0.01 ETH target per
   event, up to the daily cap of 1 ETH, 15 buys/hour) at amountOutMinimum=0.
3. The attacker drains the ETH the bot deposited into the pool (sandwich / asymmetric pool / sell
   tax / honeypot that blocks the bot from selling back).

This is repeatable and requires no credentials, no Telegram owner, and no operator action: a
direct theft of the bot's funds by any on-chain actor.

## PoC

The PoC runs the **real, unmodified** vulnerable path
(pollNewPoolEvents -> maybeAutoLp -> executeSplitSnipe -> swapWethToTokenMultiFire ->
sendExactInput -> sign+broadcast). It is fully hermetic:

- a random throwaway key generated in-process (never funded, never used elsewhere);
- a local mock JSON-RPC server on 127.0.0.1 emulating Robinhood Chain: it serves one attacker
  PairCreated log and then captures every eth_sendRawTransaction;
- global fetch sandboxed so only 127.0.0.1 is reachable (GoPlus/Telegram/KyberSwap are stubbed).

No real funds, accounts, or live services are touched.

### Command

```
npm install
node --import tsx poc/autobuy-poc.ts
```

### Output (exit code 0)

```
-- shipped config (config.json, unmodified) --
  autoLp.enabled   = true
  autoLp.mode      = buy
  autoLp.requireLlm= false
  autoLp.sources   = ["watch-spike","feed-new","manual-cmd","gmgn-trending","noxa-curve","poke-ai"]
  bot wallet       = 0x2bf36eBF2E106a5001de1dd6824b3343336c3ac1 (random, unfunded)
  attacker token   = 0xbadbad0000000000000000000000000000000bad

Attacker deploys a WETH pool on-chain; bot's chain listener polls once...
[..] INFO  autolp - FAST PATH 0xbadbad source=feed-new
[..] INFO  chain-listener - ON-CHAIN V2 / FOMO / ZeroHood POOL DETECTED (0xbadbad...bad)
[..] INFO  autolp - SPLIT SNIPE Multi-fire 0.0031 / 0.0021 / 0.0048 -> 0xbadbad fee=3000

Transactions the bot broadcast to the (mock) chain: 5

+- BOT BROADCAST AN UNSOLICITED BUY OF THE ATTACKER TOKEN -
| tx hash          : 0x042d86f5...
| router (tx.to)   : 0xcaf681a66d020601342297493863e78c959e5cb2
| tokenOut (bought): 0xbaDBad...Bad == attacker token OK
| amountIn (WETH)  : 0.00308 ETH of real funds
| amountOutMinimum : 0 == 0  -> ZERO slippage protection
+----------------------------------------------------------

PoC RESULT: VULNERABLE - unprivileged attacker drains bot via auto-buy
```

The 5 captured broadcasts are: WETH deposit (wrap), router approve, and 3 exactInputSingle
swap tranches buying the attacker token with amountOutMinimum = 0.

## Suggested remediation

- Ship `config.json` with `autoLp.enabled: false` (match the schema default and the docs).
- Require a real, completed security audit before buying, including on "fast" sources; do not
  fabricate a max-confidence verdict for unverified on-chain pools.
- Never execute auto-buys with `amountOutMinimum: 0`; derive a minimum-out from a fresh quote and
  a slippage floor.
- Add liquidity/age/holder floors that cannot be trivially faked by the pool creator.

## Submission venue

Owner's bug-bounty board; report tracked in this PR (full write-up + runnable PoC), with a live
summary in the program's #verified-findings channel once re-verified from a fresh clone of this
branch.
