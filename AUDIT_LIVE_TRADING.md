# Live-Mode Real-Trading Audit — `nftboy07/Robinhood`

Audit of `robinhood_bot.js` (3,827 lines) + `db_manager.js`, `mempool_monitor.js`, config and ops files.
Scope: **what will lose money, lose funds, or silently break when running live with real ETH.**

Verdict: the code runs and the plumbing (RPC failover, Telegram, polling, graduation detect) is decent, but
**the money-handling paths have several correctness bugs that will cause real losses.** Do not scale size
above dust until at least the P0 list is fixed.

---

## P0 — Blockers. Will lose funds / corrupt state. Fix before any real size.

### 1. Every partial sell DELETES the whole position from state
`sellPercent()` / TP-ladder / trailing all build a throwaway object and hand it to `sellPosition()`:

```js
const tempPos = {...pos, amount: sellAmount};
await sellPosition(tempPos, 'TAKE_PROFIT');
pos.soldAmount = (pos.soldAmount || 0n) + sellAmount;   // written AFTER
```

But `sellPosition()` on success runs (lines 3178/3189/3212/3223):

```js
positions = positions.filter(p => (p.token || p.curve) !== posKey);
```

That matches on the **token key**, so it removes the *real* position from the array. The subsequent
`pos.soldAmount +=` then mutates an object that is no longer tracked, and `savePositions()` persists the
array *without* it.

**Real-world effect:** the moment TP1 (+50%) fires and sells 30%, the bot forgets the remaining 70%.
No trailing stop, no stop-loss, no TP2/TP3, no moonbag management. The rest of the bag is orphaned
on-chain and rides to zero unmonitored. This is the single most expensive bug in the repo.

**Fix:** give `sellPosition()` an explicit `{ closePosition: boolean }` (or return the filled amount and
let the *caller* decide). Only remove from `positions` when `pos.amount - pos.soldAmount <= 0n`.
Never let a partial-sell path reach the `filter()`.

### 2. Curve sells have no ERC20 approval → every SL/TP on the curve reverts
`sellPosition()` calls `curve.sell(posKey, sellAmt)` on the FACTORY. `grep` for an approval to `FACTORY`
returns **nothing** — the bot approves the V2 `ROUTER` (line 2633) and Permit2 (line 3044), but never the
bonding-curve factory.

Unless the NOXA factory pulls tokens via an internal mechanism (it almost certainly uses `transferFrom`),
**every single bonding-curve sell reverts.** And look at the catch block (line 3214+): on failure it sets
`pos.isMigrated = true` and tries a DEX sell that doesn't exist yet → returns `null` → position is then
permanently skipped by `manageSafeStrategy()` because of the `if (pos.isMigrated) return;` guard at 3348.

**Net: one failed sell permanently disables all risk management on that position.** You cannot stop out.

**Fix:** add an `ensureApproval(token, FACTORY, amount)` helper before curve sells, mirroring the router
logic. Also, do not set `isMigrated = true` as a generic error fallback — that flag should only be set by
real graduation detection.

### 3. Buys have zero slippage protection — `minOut` is declared and thrown away
In `snipe()` (2741), `buyToken()` (1279) and `forceBuy()` (1383):

```js
let minOut = 0n;
...
const tx = await curve.buy(curveAddress, { value: SNIPE_AMOUNT, ... });  // minOut never passed
```

`SLIPPAGE_PCT` (default 15) is configured, exposed in the dashboard, and adjustable via Telegram — but it
is **only ever applied in `sellOnDex()`**. Buys are fully unprotected. On a fast launchpad with sandwich
bots and 0.1s blocks, you are guaranteed to eat worst-case fills.

Note the ABI is `buy(address token) payable` with no `minOut` argument. So either:
- the real contract has an overload with a min-out param (re-verify the ABI on Blockscout), or
- there is genuinely no on-chain protection — in which case you **must** do a pre-flight
  `estimateBuyOutput()` and abort if the quote drifted more than `SLIPPAGE_PCT` from the estimate taken
  moments earlier. Right now `estimated` is computed at line 2690 and only used for logging.

### 4. Risk limits are dead code — nothing is enforced
`checkRiskLimits()` is defined at 2559 and **never called** (`grep -c "checkRiskLimits()"` → 1, the
definition). Consequences, all live right now:

- `maxConcurrentPositions` / `MAX_POS` — **never checked in `snipe()` or `snipeV4()`.** It's only mutated
  by Telegram buttons (1135/1138). The bot will open unlimited positions and drain the wallet on a
  launch burst.
- `maxDailyLossPct` — never enforced. And the calculation itself is broken:
  `Math.abs(dailyStats.realizedPnl / 1) * 100` divides by literal `1`, so it compares absolute ETH PnL
  to a *percentage* threshold. Meaningless.
- `maxTradesPerHour` — compared against `dailyStats.trades`, a **daily** counter that only resets every
  24h. So it's a hard daily cap of 20 trades mislabelled as hourly, and it's not enforced anyway.

**Fix:** call `checkRiskLimits()` at the top of `snipe()`, `snipeV4()`, `buyToken()` and the re-entry path.
Add the `positions.length >= MAX_POS` guard. Track hourly trades in a separate rolling window. Compute
daily loss as a percentage of session-start wallet balance.

### 5. No duplicate-snipe guard — the same launch gets bought repeatedly
`pollNewLaunches()` re-scans a **400-block window** every poll (line 3517: `fromBlock = max(last+1, current - 400)`),
and the mempool monitor callback *also* calls `pollNewLaunches()` on every detected pending tx. There is
no `seenTokens`/`processedTx` set anywhere (`grep` → NONE). Additionally the error path does
`lastPolledBlock += 5` — advancing past unscanned blocks on failure (missed launches) while the clamp can
simultaneously re-serve old ones.

The only thing preventing repeat buys is that `snipe()` doesn't check existing positions either — it does
a bare `positions.push(...)`.

**Effect:** duplicate positions on the same token, multiplied buys, wallet drain on any RPC hiccup.

**Fix:** persistent `Set` of processed `(txHash, logIndex)` or token addresses; check it before snipe and
before push. Debounce the mempool→poll trigger.

### 6. `savePositions()` / `loadPositions()` swallow all errors and can corrupt on crash
Both wrap everything in `try {} catch (e) {}` with an **empty body** (1888, 1902). A disk-full, permission
error, or malformed JSON silently produces `positions = []` — the bot then thinks it holds nothing and
stops managing real on-chain bags. `fs.writeFileSync` direct to the live file is also non-atomic: a crash
mid-write leaves truncated JSON, which `loadPositions()` then silently turns into an empty portfolio.

**Fix:** write to `positions.json.tmp` then `fs.renameSync` (atomic). Log loudly on any load/save failure
and refuse to start trading if the positions file exists but fails to parse.

---

## P1 — High. Wrong behaviour, bad fills, or lost profit.

### 7. Trailing stop uses a float→BigInt conversion that overflows
```js
const peak = Number(pos.highestPrice);          // wei as JS float — loses precision > 2^53
const trailingPrice = peak * (1 - TRAILING);
if (currentPrice < BigInt(Math.floor(trailingPrice)))
```
`pos.highestPrice` is wei-scale. `Number()` on it silently loses precision, and `BigInt(Math.floor(...))`
throws `RangeError` on any non-integer float. Wrapped in the monitor's `catch` at 3311 which only logs at
`debug` level — so **the trailing stop can be silently dead and you'd never see it in the logs.**

**Fix:** stay in BigInt: `const trailingPrice = pos.highestPrice * BigInt(10000 - Math.floor(TRAILING*10000)) / 10000n;`

### 8. Stop-loss sells `pos.amount`, ignoring `soldAmount` and the moonbag
`sellPosition()` line 3162: `const sellAmt = pos.amount;` — the *original* size, not
`pos.amount - pos.soldAmount`. After any TP has fired, the SL tries to sell more tokens than you hold →
revert → (see bug #2) → position permanently unmanaged. It also blows through the moonbag that
`manageSafeStrategy()` carefully reserved four lines earlier.

### 9. Re-entry adds a fabricated token amount to the position
```js
await curve.buy(pos.token, { value: reAmount, gasLimit: ... });   // never awaits the receipt
const tokenEst = await estimateBuyOutput(pos.token, reAmount).catch(() => 0n);
const amountReceived = tokenEst > 0n ? tokenEst : reAmount;       // fallback = ETH amount as tokens!
pos.amount += amountReceived;
```
Three problems: (a) the tx is never `.wait()`ed so a reverted re-entry still credits tokens;
(b) the estimate is taken *after* the buy already moved the price; (c) the fallback adds a **wei-denominated
ETH value** into a token balance. `entryPrice` is never re-averaged either, so all subsequent PnL, TP and
SL maths on that position are wrong.

**Fix:** await the receipt, use `getReceivedAmountFromReceipt()` (already exists and is correct), and
recompute a weighted-average `entryPrice`.

### 10. `sendTxWithBumping()` — the anti-stuck logic — is never called
Defined at 2168, zero call sites. All buys/sells use a plain `tx.wait()` with a 120s timeout. On a
congested block, a snipe just sits there. Given 0.1s blocks this is the difference between a fill and a
missed launch. Wire it into `snipe()` and `sellPosition()`.

### 11. `withTimeout` on `tx.wait()` leaves the tx in flight
`withTimeout(tx.wait(), 120000)` rejects after 120s, and the catch treats it as a failed buy — but the
transaction may still land afterwards. You'll hold an untracked position with no stop-loss. On timeout,
poll `getTransactionReceipt(tx.hash)` before declaring failure.

### 12. `triggerRpcFailover()` fires on *every* `withRetry` error
Line 1913 rotates the RPC on any exception, including plain contract reverts and timeouts that have
nothing to do with the node. With a single-entry `RPCS` array (the shipped default) it's a no-op, but
once you add backups this will thrash between providers on ordinary reverts. Only fail over on network-class
errors (`SERVER_ERROR`, `TIMEOUT`, `NETWORK_ERROR`, 429).

### 13. Nonce management is absent
`snipe()` fires from a `setTimeout`, `monitorPositions()` runs on a 4.5s interval, and Telegram commands
execute concurrently — all from the same `wallet` with no nonce lock. Two concurrent sends will grab the
same nonce from the provider and one gets dropped (`replacement underpriced` / `nonce too low`). Add a
serialized tx queue or an explicit local nonce manager.

### 14. Honeypot check probes the wrong thing and fails open
- `factory.sell.estimateGas(actualToken, 1000n)` is run **while holding zero tokens** — it will revert for
  balance reasons, `.catch(() => 999999n)` returns a sentinel *below* the `1000000n` threshold, so the
  sell-side honeypot test passes unconditionally. It is decorative.
- The general catch (2503) returns `false` (= safe to buy) on unrecognised errors.
- `checkBytecodeSimilarity()` returns `true` (allow) on empty bytecode and on any network error.

The V4 path (`isV4Honeypot`) is much better — it does a real Quoter round-trip buy→sell simulation with an
80% threshold. **Port that approach to the curve path**: static-call a buy, then static-call a sell of the
resulting amount, and compare.

---

## P2 — Medium. Accuracy, ops, and security hygiene.

15. **PnL accounting is dimensionally wrong.** `logTradeToHistory()` computes
    `Number(formatEther(entryPrice)) * Number(formatEther(sellAmount))` — multiplying two 1e-18-scaled
    floats. Every `pnlEth` in `trades_history.json`, the `/stats` win-rate, and `dailyStats.realizedPnl`
    are off by orders of magnitude. Compute proceeds from the actual ETH delta in the sell receipt instead.

16. **Two sources of truth for trade history.** `db_manager.logTrade()` exists but `logTradeToHistory()`
    writes the same file directly with `fs.writeFileSync`. Pick one; the dual writers will clobber
    each other.

17. **Unbounded history file.** `logTradeToHistory()` never caps `history` — it re-reads, pushes and
    rewrites the entire array on every trade. Grows without limit; O(n) disk write per sell.
    `db_manager` caps launches at 200 but trades are uncapped.

18. **`uncaughtException` handler keeps running after arbitrary corruption.** Line 3814 logs and continues
    deliberately. For a bot holding funds this is the wrong default — an unknown exception mid-sell can
    leave `positions` inconsistent with chain reality. Better: save state, exit non-zero, let PM2 restart
    clean (`autorestart: true` is already set in `ecosystem.config.js`).

19. **`loadPositions()` fires async work in a sync `forEach`.** The `positions.forEach(async (p) => ...)`
    name-refresh at 1877 is unawaited — harmless but the mutations may land after the first
    `savePositions()`.

20. **`getBalance()` returns `0n` on total RPC failure.** `snipe()` reads that as "low balance" and skips —
    fail-safe here, but `handleStatus`/dashboard will report a scary 0.00 ETH balance. Distinguish
    "unknown" from "zero".

21. **Hardcoded addresses scattered in code.** The Quoter (`0x8dc178...`, line 2530), Permit2, and the
    six-entry `KNOWN_LAUNCH_CONTRACTS` list are inline constants. Move to `config.json` so they can be
    corrected without a code deploy. The README itself warns these must be independently verified —
    re-verify all of them on Blockscout before live use.

22. **Bytecode templates are brittle.** `checkBytecodeSimilarity()` matches exact byte-lengths
    (3324 / 9488 / 9316) and long hex prefixes. Any launchpad contract upgrade silently blocks every
    new token (returns `false` → treated as honeypot). Needs a version/registry approach or at minimum
    a loud alert when nothing matches.

23. **Gas config.** `gasMultiplier: 1.8` is applied to `maxFeePerGas` but `maxPriorityFeePerGas` falls back
    to `maxFee / 2` — on an Arbitrum Orbit L2 priority fee is near-irrelevant while the L1 data component
    dominates. Fixed `gasLimit: 550000` / `600000` on sells is a guess; estimate and pad instead.

24. **`.env.example` starts with a UTF-8 BOM** (`\ufeff` before `#`). Some `dotenv`/shell workflows choke
    on the first key if it's copied verbatim. Strip it.

25. **`package.json` `"test"` is a no-op echo.** There is not a single test for the curve maths, position
    accounting, or the strategy state machine — the exact areas where bugs #1, #7, #8 and #15 live. These
    are all pure functions and trivially unit-testable.

26. **Repo hygiene.** 10 `patch_*.js` one-shot migration scripts and 3 `probe_*.js` scratch files are
    committed at root. `data/` (written by `db_manager`) is not in `.gitignore` — launch history will get
    committed. Secrets handling itself is correct: PK only via `process.env.PK`, never logged.

---

## Suggested fix order

**Before you trade live at all (P0):** #1 partial-sell state wipe → #2 curve approval → #4 wire up risk
limits + MAX_POS → #5 dedupe guard → #6 atomic saves → #3 buy slippage.

**Then (P1):** #7 trailing BigInt → #8 SL sells remaining → #9 re-entry accounting → #13 nonce queue →
#14 real honeypot simulation → #10/#11 tx bumping and timeout handling.

**Then (P2):** #15 PnL maths → #16/#17 history consolidation → tests → config/repo cleanup.

---

## Things the code already gets right

- Secrets discipline: PK read only from env, `.gitignore` covers `.env`/`config.json`/`positions.json`, no
  keys in source.
- `getReceivedAmountFromReceipt()` is the correct way to determine fill size — it just isn't used
  everywhere it should be (notably the re-entry path).
- Overlap guards (`pollingInProgress` / `monitoringInProgress`) prevent the classic interval pile-up.
- Block-range clamping (400) stops runaway `getLogs` scans.
- The V4 honeypot Quoter round-trip is genuinely good — it's the model the curve path should copy.
- Graduation detection via `tokenBalance == 0 && virtualEth == 0` plus the `CurveCompleted` event is a
  sensible belt-and-braces approach.
- DEX sell correctly checks pair existence *and* non-zero reserves before attempting.
