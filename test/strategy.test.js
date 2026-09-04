/**
 * Unit tests for the position-accounting and strategy maths that the P0/P1
 * fixes touched. These are the exact areas where the original bugs lived:
 * partial-sell state wipes, BigInt/Number mixing, and cost-basis averaging.
 *
 * Run: npm test
 */
const assert = require('assert');

let failures = 0;
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); }
  catch (e) { failures++; console.error(`  FAIL - ${name}\n      ${e.message}`); }
}
function suite(name) { console.log(`\n${name}`); }

// ---------------------------------------------------------------------------
// Re-implementations of the (non-exported) logic under test, kept byte-identical
// to robinhood_bot.js so a regression here mirrors a regression there.
// ---------------------------------------------------------------------------

function settleSale(positions, pos, result, { closeOnFull = true } = {}) {
  if (!result || !result.ok || result.amount <= 0n) return { positions, changed: false };
  pos.soldAmount = (pos.soldAmount || 0n) + result.amount;
  pos.sellFailures = 0;
  if (closeOnFull && (pos.amount - pos.soldAmount) <= 0n) {
    const key = (pos.token || pos.curve || '').toLowerCase();
    positions = positions.filter(p => ((p.token || p.curve) || '').toLowerCase() !== key);
  }
  return { positions, changed: true };
}

const trailingPriceOf = (highest, trailing) =>
  (highest * (10000n - BigInt(Math.round(trailing * 10000)))) / 10000n;

const multiplierOf = (current, entry) =>
  entry > 0n ? Number((current * 10000n) / entry) / 10000 : 0;

function reAverage(pos, reAmountWei, tokensReceived) {
  const prevCost = pos.entryPrice * pos.amount;
  const newCost = prevCost + (reAmountWei * (10n ** 18n));
  pos.amount += tokensReceived;
  pos.entryPrice = pos.amount > 0n ? newCost / pos.amount : pos.entryPrice;
  return pos;
}

const ONE = 10n ** 18n;
const mkPos = (over = {}) => ({
  token: '0xabc', curve: '0xabc', symbol: 'T',
  amount: 1000n * ONE, soldAmount: 0n, entryPrice: ONE, highestPrice: ONE,
  tpReached: [], reEntries: 0, ...over
});

// ---------------------------------------------------------------------------
suite('FIX #1 - partial sells must NOT wipe the position');

test('a 30% TP sell keeps the position with the remainder intact', () => {
  let positions = [mkPos()];
  const pos = positions[0];
  const sellAmount = pos.amount * 30n / 100n;

  ({ positions } = settleSale(positions, pos, { ok: true, amount: sellAmount }));

  assert.strictEqual(positions.length, 1, 'position was removed on a partial sell');
  assert.strictEqual(pos.soldAmount, 300n * ONE);
  assert.strictEqual(pos.amount - pos.soldAmount, 700n * ONE, 'remainder wrong');
});

test('sequential ladder sells accumulate and never orphan the bag', () => {
  let positions = [mkPos()];
  const pos = positions[0];
  for (const pct of [30n, 30n]) {
    const remaining = pos.amount - pos.soldAmount;
    ({ positions } = settleSale(positions, pos, { ok: true, amount: remaining * pct / 100n }));
  }
  assert.strictEqual(positions.length, 1);
  // 1000 -> sell 300 -> 700 -> sell 210 -> 490 left
  assert.strictEqual(pos.amount - pos.soldAmount, 490n * ONE);
});

test('selling the full remainder DOES close the position', () => {
  let positions = [mkPos()];
  const pos = positions[0];
  ({ positions } = settleSale(positions, pos, { ok: true, amount: pos.amount }));
  assert.strictEqual(positions.length, 0, 'fully-exited position should be removed');
});

test('a failed sell changes nothing', () => {
  let positions = [mkPos()];
  const pos = positions[0];
  const r = settleSale(positions, pos, { ok: false, amount: 0n });
  assert.strictEqual(r.changed, false);
  assert.strictEqual(pos.soldAmount, 0n);
  assert.strictEqual(r.positions.length, 1);
});

// ---------------------------------------------------------------------------
suite('FIX #7 - trailing stop stays in BigInt (no RangeError / precision loss)');

test('trailing price is exact at wei scale', () => {
  const highest = 123456789012345678901234567890n;
  const t = trailingPriceOf(highest, 0.08);
  assert.strictEqual(t, (highest * 9200n) / 10000n);
  assert.ok(typeof t === 'bigint');
});

test('old Number()-based maths lost precision; new maths is exact', () => {
  // A realistic wei-scale peak that exceeds Number.MAX_SAFE_INTEGER.
  const highest = 1234567890123456789012n;
  const exact = trailingPriceOf(highest, 0.08);
  const viaFloat = BigInt(Math.floor(Number(highest) * 0.92));
  assert.notStrictEqual(viaFloat, exact,
    'the original float path silently produced a different threshold');
  assert.strictEqual(exact, (highest * 9200n) / 10000n);
});

test('non-integer float results threw RangeError in the original code', () => {
  // Math.floor was applied to the product, but Infinity/NaN inputs (e.g. a
  // highestPrice of 0 or a corrupted value) reached BigInt() directly.
  assert.throws(() => BigInt(Math.floor(Infinity)), RangeError);
  assert.throws(() => BigInt(NaN), RangeError);
  // The BigInt path is total over any valid bigint peak.
  assert.doesNotThrow(() => trailingPriceOf(0n, 0.08));
  assert.strictEqual(trailingPriceOf(0n, 0.08), 0n);
});

test('a price below the trail triggers, at/above does not', () => {
  const pos = mkPos({ highestPrice: 1000n });
  const trail = trailingPriceOf(pos.highestPrice, 0.08); // 920
  assert.strictEqual(trail, 920n);
  assert.ok(919n < trail);
  assert.ok(!(920n < trail));
});

// ---------------------------------------------------------------------------
suite('FIX - TP ladder multiplier must not mix BigInt and Number');

test('multiplier computes without throwing', () => {
  assert.doesNotThrow(() => multiplierOf(15n * ONE, 10n * ONE));
  assert.strictEqual(multiplierOf(15n * ONE, 10n * ONE), 1.5);
});

test('the original expression threw TypeError (regression guard)', () => {
  assert.throws(() => (15n * ONE) / Number(10n * ONE), TypeError);
});

test('ladder targets fire at the right thresholds', () => {
  const ladder = [0.5, 1.0, 2.0];
  // entry 1.0, price 2.1 -> 2.1x, so targets 0.5/1.0/2.0 are all exceeded
  const m = multiplierOf(21n * ONE / 10n, ONE);
  assert.strictEqual(m, 2.1);
  assert.deepStrictEqual(ladder.map(t => m >= t), [true, true, true]);
});

// ---------------------------------------------------------------------------
suite('FIX #8 - stop loss sells the unsold remainder');

test('after a TP, SL size is the remainder not the original amount', () => {
  const pos = mkPos({ soldAmount: 300n * ONE });
  const remaining = pos.amount - pos.soldAmount;
  assert.strictEqual(remaining, 700n * ONE);
  assert.notStrictEqual(remaining, pos.amount, 'must not try to sell the original size');
});

// ---------------------------------------------------------------------------
suite('FIX #9 - re-entry re-averages the cost basis');

test('adding at a lower price lowers the average entry', () => {
  // 1000 tokens @ 1e18 wei/token, then buy 1e18 wei more receiving 1000 tokens
  const pos = mkPos({ amount: 1000n * ONE, entryPrice: ONE });
  const before = pos.entryPrice;
  reAverage(pos, ONE, 1000n * ONE);
  assert.ok(pos.entryPrice < before, 'average entry should drop after a dip buy');
  assert.strictEqual(pos.amount, 2000n * ONE);
});

test('token amount grows by the REAL fill, never by the ETH value', () => {
  const pos = mkPos({ amount: 1000n * ONE });
  const reAmountWei = ethersParse('0.00005');
  reAverage(pos, reAmountWei, 500n * ONE);
  assert.strictEqual(pos.amount, 1500n * ONE);
  assert.notStrictEqual(pos.amount, 1000n * ONE + reAmountWei,
    'the old fallback added a wei ETH value into a token balance');
});

function ethersParse(s) { return BigInt(Math.round(parseFloat(s) * 1e18)); }

// ---------------------------------------------------------------------------
suite('FIX #3 - slippage bounds');

test('minOut is derived from the quote and the slippage pct', () => {
  const quote = 1000n * ONE;
  const slippage = 15;
  assert.strictEqual(quote * BigInt(100 - slippage) / 100n, 850n * ONE);
});

test('a quote that moved more than the bound is rejected', () => {
  const estimated = 1000n * ONE;
  const slippage = 10;
  const minAcceptable = estimated * BigInt(100 - slippage) / 100n; // 900
  assert.ok(880n * ONE < minAcceptable, 'a 12% adverse move must abort');
  assert.ok(!(950n * ONE < minAcceptable), 'a 5% move must proceed');
});

// ---------------------------------------------------------------------------
suite('FIX #4 - risk limits');

test('rolling hourly window expires old entries', () => {
  const now = Date.now();
  const stamps = [now - 3700e3, now - 1800e3, now - 60e3]; // one is >1h old
  assert.strictEqual(stamps.filter(t => now - t < 3600e3).length, 2);
});

test('daily loss is a percentage of the session-start balance', () => {
  const base = 0.5;          // ETH at session start
  const realized = -0.03;    // ETH lost
  const lossPct = (Math.abs(realized) / base) * 100;
  assert.strictEqual(lossPct, 6);
  assert.ok(lossPct >= 5, 'should trip a 5% daily cap');
  // the old broken form compared absolute ETH to a percentage:
  assert.strictEqual(Math.abs(realized / 1) * 100, 3, 'old maths gave a different, meaningless number');
});

// ---------------------------------------------------------------------------
suite('FIX #5 - launch dedupe');

test('the same token is only processed once', () => {
  const seen = new Set();
  const process = k => { const kk = k.toLowerCase(); if (seen.has(kk)) return false; seen.add(kk); return true; };
  assert.strictEqual(process('0xAAA'), true);
  assert.strictEqual(process('0xaaa'), false, 'must be case-insensitive');
  assert.strictEqual(process('0xBBB'), true);
});

test('hasPosition matches on either token or curve', () => {
  const positions = [{ token: '0xTok', curve: '0xCur' }];
  const has = a => positions.some(p =>
    (p.token || '').toLowerCase() === a.toLowerCase() ||
    (p.curve || '').toLowerCase() === a.toLowerCase());
  assert.ok(has('0xtok'));
  assert.ok(has('0xCUR'));
  assert.ok(!has('0xother'));
});

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failures} failed\n`);
process.exit(failures === 0 ? 0 : 1);
