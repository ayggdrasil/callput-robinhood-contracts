import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {OptionsMarketItem} from '../_shared/types/mark-iv-price';
import {isSpreadStyle, selectSpread, SPREAD_STYLES} from './strategy';

const expiry = 2_000;
const option = (strikePrice: number, markPrice: number, n: number, isOptionAvailable = true) => ({
  optionId: `0x${n.toString(16).padStart(64, '0')}`,
  strikePrice, markPrice, markIv: 0.5, riskPremiumRateForBuy: 0,
  riskPremiumRateForSell: 0, delta: 0, gamma: 0, vega: 0, theta: 0,
  volume: 1, isOptionAvailable,
});
const chain = (call = [option(130, 1, 4), option(105, 5, 2), option(110, 4, 3), option(100, 8, 1)]): OptionsMarketItem => ({
  expiries: [expiry], options: {[String(expiry)]: {call, put: []}},
});

test('balanced and conservative select the first threshold strike and farthest protective call', () => {
  const balanced = selectSpread({symbol: 'NVDA', market: chain(), price: '100', expiry,
    style: 'balanced', sourceAt: 1_000, now: 1_100});
  assert.equal(balanced.short.strikePrice, 105);
  assert.equal(balanced.long.strikePrice, 130);
  assert.equal(balanced.width, '25');
  assert.equal(balanced.premium, '4');
  assert.equal(balanced.sourceAt, 1_000);

  const conservative = selectSpread({symbol: 'NVDA', market: chain(), price: '100', expiry,
    style: 'conservative', sourceAt: 1_000, now: 1_100});
  assert.equal(conservative.short.strikePrice, 110);
  assert.equal(conservative.long.strikePrice, 130);
  assert.equal(conservative.premium, '3');
});

test('lower-moneyness styles select the nearest available short and keep the farthest protective call', () => {
  const calls = [option(130, 1, 5), option(101, 6, 3), option(96, 7, 2), option(90, 8, 1), option(104, 5, 4)];
  const itm = selectSpread({symbol: 'NVDA', market: chain(calls), price: '100', expiry,
    style: 'itm', sourceAt: 1_000, now: 1_100});
  assert.equal(itm.short.strikePrice, 96);
  assert.equal(itm.long.strikePrice, 130);

  const atm = selectSpread({symbol: 'NVDA', market: chain(calls), price: '100', expiry,
    style: 'atm', sourceAt: 1_000, now: 1_100});
  assert.equal(atm.short.strikePrice, 101);
  assert.equal(atm.long.strikePrice, 130);

  const near = selectSpread({symbol: 'NVDA', market: chain(calls), price: '100', expiry,
    style: 'near', sourceAt: 1_000, now: 1_100});
  assert.equal(near.short.strikePrice, 104);
  assert.equal(near.long.strikePrice, 130);
});

test('nearest selection prefers the higher strike on a tie and skips unavailable or unprotected candidates', () => {
  const selected = selectSpread({symbol: 'NVDA', market: chain([
    option(130, 1, 6), option(110, 4, 5, false), option(105, 5, 4), option(95, 7, 3),
    option(90, 8, 2), option(80, 9, 1),
  ]), price: '100', expiry, style: 'atm', sourceAt: 1_000, now: 1_100});
  assert.equal(selected.short.strikePrice, 105);
  assert.equal(selected.long.strikePrice, 130);

  const protectedCandidate = selectSpread({symbol: 'NVDA', market: chain([
    option(100, 5, 1), option(130, 1, 2),
  ]), price: '130', expiry, style: 'atm', sourceAt: 1_000, now: 1_100});
  assert.equal(protectedCandidate.short.strikePrice, 100);
  assert.equal(protectedCandidate.long.strikePrice, 130);

  const duplicateTopStrike = selectSpread({symbol: 'NVDA', market: chain([
    option(100, 5, 1), option(130, 2, 2), option(130, 1, 3),
  ]), price: '130', expiry, style: 'atm', sourceAt: 1_000, now: 1_100});
  assert.equal(duplicateTopStrike.short.strikePrice, 100);
  assert.equal(duplicateTopStrike.long.strikePrice, 130);
});

test('in-the-money selection stays below spot and fails closed when no eligible short exists', () => {
  const fallback = selectSpread({symbol: 'NVDA', market: chain([
    option(130, 1, 5), option(100, 5, 4), option(95, 6, 3, false), option(94, 7, 2), option(90, 8, 1),
  ]), price: '100', expiry, style: 'itm', sourceAt: 1_000, now: 1_100});
  assert.equal(fallback.short.strikePrice, 94);
  assert.equal(fallback.long.strikePrice, 130);

  assert.throws(() => selectSpread({symbol: 'NVDA', market: chain([
    option(100, 5, 1), option(110, 3, 2), option(130, 1, 3),
  ]), price: '100', expiry, style: 'itm', sourceAt: 1_000, now: 1_100}), /available calls|spread/i);
});

test('exports the five ordered styles and rejects unknown runtime values', () => {
  assert.deepEqual(SPREAD_STYLES.map(({id, label}) => ({id, label})), [
    {id: 'itm', label: 'In the money'},
    {id: 'atm', label: 'At the money'},
    {id: 'near', label: 'Near the money'},
    {id: 'balanced', label: 'Balanced'},
    {id: 'conservative', label: 'Conservative'},
  ]);
  assert.equal(isSpreadStyle('near'), true);
  assert.equal(isSpreadStyle('unknown'), false);
  assert.throws(() => selectSpread({symbol: 'NVDA', market: chain(), price: '100', expiry,
    style: 'unknown' as never, sourceAt: 1_000, now: 1_100}), /style/i);
});

test('skips unavailable legs but fails closed when two valid calls cannot be selected', () => {
  const selected = selectSpread({symbol: 'TSLA', market: chain([
    option(105, 5, 1, false), option(110, 4, 2), option(125, 2, 3, false), option(120, 2.5, 4),
  ]), price: '100', expiry, style: 'balanced', sourceAt: 1_000, now: 1_100});
  assert.equal(selected.short.strikePrice, 110);
  assert.equal(selected.long.strikePrice, 120);
  assert.throws(() => selectSpread({symbol: 'TSLA', market: chain([option(110, 4, 2)]),
    price: '100', expiry, style: 'balanced', sourceAt: 1_000, now: 1_100}), /two available calls/i);
});

test('rejects stale, future, expired and economically invalid market data', () => {
  const base = {symbol: 'AAPL', market: chain(), price: '100', expiry,
    style: 'balanced' as const, sourceAt: 1_000, now: 1_100};
  assert.throws(() => selectSpread({...base, now: 1_151}), /stale/i);
  assert.throws(() => selectSpread({...base, sourceAt: 1_101}), /future/i);
  assert.throws(() => selectSpread({...base, sourceAt: expiry, now: expiry}), /expired/i);
  assert.throws(() => selectSpread({...base, price: '0'}), /price/i);
  assert.throws(() => selectSpread({...base, market: chain([option(105, 1, 1), option(120, 2, 2)])}), /premium/i);
  assert.throws(() => selectSpread({...base, market: chain([option(105, Number.NaN, 1), option(120, 1, 2)])}), /invalid option/i);
});

test('requires the requested expiry to be an active chain member', () => {
  const market = chain();
  assert.throws(() => selectSpread({symbol: 'NVDA', market, price: '100', expiry: expiry + 1,
    style: 'balanced', sourceAt: 1_000, now: 1_100}), /expiry/i);
});
