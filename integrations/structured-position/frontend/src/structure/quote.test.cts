import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {Address} from 'viem';
import {CONTRACT_ADDRESSES, SupportedChains} from '../_shared';
import {STOCK_INCOME_MARKETS, USDG} from '../networks/stockIncome';
import type {Spread} from './strategy';
import {quoteSpread} from './quote';

const account = '0x1111111111111111111111111111111111111111' as Address;
const vault = '0x2222222222222222222222222222222222222222' as Address;
const utils = '0x3333333333333333333333333333333333333333' as Address;
const market = STOCK_INCOME_MARKETS[0];
const expiry = 10_000;
const option = (strikePrice: number, markPrice: number, n: number) => ({optionId: `0x${n.toString(16).padStart(64, '0')}`,
  strikePrice, markPrice, markIv: .5, riskPremiumRateForBuy: 0, riskPremiumRateForSell: 0,
  delta: 0, gamma: 0, vega: 0, theta: 0, volume: 1, isOptionAvailable: true});
const spread: Spread = {symbol: 'NVDA', expiry, short: option(105, 5, 1), long: option(115, 2, 2),
  width: '10', premium: '3', sourceAt: 1_000};

function reader(overrides: {chainId?: number; expiry?: number; perShare?: bigint;
  fee?: (amount: bigint) => readonly [bigint, bigint, bigint, bigint, Address, bigint, boolean]} = {}) {
  const calls: any[] = [];
  const fee = overrides.fee ?? ((amount: bigint) => [0n, (amount - 1_000_000n) * 10n ** 18n / 10_000_000n,
    0n, 1_000_000n, USDG, 0n, false] as const);
  const client = {
    async getChainId() {return overrides.chainId ?? 4663;},
    async readContract(args: any) {
      calls.push(args);
      switch (args.functionName) {
        case 'validateOpenPosition': return [BigInt(overrides.expiry ?? expiry), 987n, args.args[3]];
        // uint32 ABI decodes to a JS number on the live Robinhood deployment.
        case 'positionDeadlineBuffer': return 60;
        case 'getRequestQueueLengths': return [3n, 7n, 0n];
        case 'getVaultAddressByOptionTokenId': return vault;
        case 'usdToToken': return overrides.perShare ?? 10_000_000n;
        case 'vaultUtils': return utils;
        case 'getPositionFeeInfo': return fee(args.args[3]);
        default: throw new Error(`unexpected read ${args.functionName}`);
      }
    },
  };
  return {client, calls};
}

test('quotes the account clone against USDG and converges fee-inclusive funding', async t => {
  t.mock.method(Date, 'now', () => 1_100_000);
  const {client, calls} = reader();
  const quote = await quoteSpread(client as any, {market, spread, account, quantity: '2', multiplier: '1'});
  assert.deepEqual(quote, {amount: '21052632', size: '2005263200000000000', minSize: '1990000000000000000',
    fee: '1000000', price: '3000000000000000000000000000000', optionTokenId: '987',
    quotedAt: 1_100, expiry, target: '2000000000000000000', premiumAmount: '6015789'});
  const validation = calls.find(call => call.functionName === 'validateOpenPosition');
  assert.equal(validation.address.toLowerCase(), CONTRACT_ADDRESSES[SupportedChains.Robinhood].CONTROLLER.toLowerCase());
  assert.deepEqual(validation.args.slice(0, 2), [market.index, 2]);
  assert.deepEqual(validation.args[2], [false, true, false, false]);
  assert.deepEqual(validation.args[3].slice(0, 2), [spread.short.optionId, spread.long.optionId]);
  const positionFee = calls.filter(call => call.functionName === 'getPositionFeeInfo').at(-1);
  assert.equal(positionFee.args[0], account, 'the account clone is the quote subject');
  assert.equal(positionFee.args[1], 6);
  assert.equal(positionFee.args[2].toLowerCase(), USDG.toLowerCase());
  assert.notEqual(positionFee.args[2].toLowerCase(), CONTRACT_ADDRESSES[SupportedChains.Robinhood].S_USDG.toLowerCase());
  assert.equal(positionFee.args[4].toLowerCase(), market.underlying.toLowerCase());
  assert.equal(positionFee.args[6], 3n * 10n ** 30n);
  assert.equal(positionFee.args[9], 7n);
  const conversion = calls.find(call => call.functionName === 'usdToToken');
  assert.deepEqual(conversion.args, [USDG, 10n * 10n ** 30n, true]);
});

test('uses ceil funding arithmetic and floors the 0.5% minSize bound', async t => {
  t.mock.method(Date, 'now', () => 1_100_000);
  const {client} = reader({perShare: 1_000n, fee: amount => [0n, amount * 10n ** 18n / 1_000n, 0n, 0n, USDG, 0n, false]});
  const quote = await quoteSpread(client as any, {market, spread, account,
    quantity: '1.000000000000000001', multiplier: '1'});
  assert.equal(quote.target, '1000000000000000001');
  assert.equal(quote.amount, '1001');
  assert.equal(quote.size, '1001000000000000000');
  assert.equal(quote.minSize, '995000000000000000');
});

test('floors scientific-notation marks into the protocol 30-decimal price', async t => {
  t.mock.method(Date, 'now', () => 1_100_000);
  const {client} = reader();
  const long = {...spread.long,markPrice:1.059852735320389e-19};
  const short = {...spread.short,markPrice:0.003071381429735953};
  const q = await quoteSpread(client as any,{market,spread:{...spread,long,short,premium:'0.0030713814297359528940147264679611'},account,quantity:'2',multiplier:'1'});
  assert.equal(q.price,'3071381429735952894014726467');
});

test('fixed raw-6 funding must produce target size within +0.5%', async t => {
  t.mock.method(Date, 'now', () => 1_100_000);
  await assert.doesNotReject(() => quoteSpread(reader().client as any,
    {market, spread, account, quantity: '2', multiplier: '1', fixedAmount: '21000000'}));
  await assert.rejects(() => quoteSpread(reader().client as any,
    {market, spread, account, quantity: '2', multiplier: '1', fixedAmount: '20000000'}), /outside.*tolerance/i);
  await assert.rejects(() => quoteSpread(reader().client as any,
    {market, spread, account, quantity: '2', multiplier: '1', fixedAmount: '22000000'}), /outside.*tolerance/i);
});

test('fixed funding tolerates fee drift down to the exact order minimum; new loans still cover the target', async t => {
  t.mock.method(Date, 'now', () => 1_100_000);
  const input = {market,spread,account,quantity:'2',multiplier:'1'};
  const fixed = await quoteSpread(reader().client as any, {...input,fixedAmount:'20900000'});
  assert.equal(fixed.size,'1990000000000000000');
  assert.equal(fixed.size,fixed.minSize);
  await assert.rejects(()=>quoteSpread(reader().client as any, {...input,fixedAmount:'20899999'}),/outside.*tolerance/i);
  const newLoan = await quoteSpread(reader().client as any,input);
  assert.ok(BigInt(newLoan.size)>=BigInt(newLoan.target));
});

test('rejects stale data, wrong chain, changed expiry and malformed spread economics', async t => {
  t.mock.method(Date, 'now', () => 1_200_000);
  await assert.rejects(() => quoteSpread(reader().client as any,
    {market, spread: {...spread, sourceAt: 1_000}, account, quantity: '2', multiplier: '1'}), /stale/i);
  await assert.rejects(() => quoteSpread(reader({chainId: 8453}).client as any,
    {market, spread: {...spread, sourceAt: 1_100}, account, quantity: '2', multiplier: '1'}), /Robinhood/i);
  await assert.rejects(() => quoteSpread(reader({expiry: expiry + 1}).client as any,
    {market, spread: {...spread, sourceAt: 1_100}, account, quantity: '2', multiplier: '1'}), /expiry/i);
  await assert.rejects(() => quoteSpread(reader().client as any,
    {market, spread: {...spread, sourceAt: 1_100, premium: '4'}, account, quantity: '2', multiplier: '1'}), /premium/i);
});

test('rejects quotes too near expiry and noncanonical market routes', async t => {
  t.mock.method(Date, 'now', () => 9_850_000);
  await assert.rejects(() => quoteSpread(reader().client as any,
    {market, spread: {...spread, sourceAt: 9_800}, account, quantity: '2', multiplier: '1'}), /close to expiry/i);
  await assert.rejects(() => quoteSpread(reader().client as any,
    {market: {...market, index: market.index + 1}, spread: {...spread, sourceAt: 9_800}, account,
      quantity: '2', multiplier: '1'}), /market route/i);
});
